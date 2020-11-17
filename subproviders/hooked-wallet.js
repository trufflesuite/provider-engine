/*
 * Emulate 'eth_accounts' / 'eth_sendTransaction' using 'eth_sendRawTransaction'
 *
 * The two callbacks a user needs to implement are:
 * - getAccounts() -- array of addresses supported
 * - signTransaction(tx) -- sign a raw transaction object
 */
const {promisify} = require("es6-promisify")
const waterfall = require('async/waterfall')
const inherits = require('util').inherits
const ethUtil = require('ethereumjs-util')
const sigUtil = require('@trufflesuite/eth-sig-util')
const extend = require('xtend')
const Semaphore = require('semaphore')
const Subprovider = require('./subprovider.js')
const estimateGas = require('../util/estimate-gas.js')
const { map } = require("bluebird")
const Bluebird = require("bluebird")
const hexRegex = /^[0-9A-Fa-f]+$/g

module.exports = HookedWalletSubprovider

// handles the following RPC methods:
//   eth_coinbase
//   eth_accounts
//   eth_sendTransaction
//   eth_sign
//   eth_signTypedData
//   eth_signTypedData_v3
//   eth_signTypedData_v4
//   personal_sign
//   eth_decryptMessage
//   encryption_public_key
//   personal_ecRecover
//   parity_postTransaction
//   parity_checkRequest
//   parity_defaultAccount

//
// Tx Signature Flow
//
// handleRequest: eth_sendTransaction
//   validateTransaction (basic validity check)
//     validateSender (checks that sender is in accounts)
//   processTransaction (sign tx and submit to network)
//     approveTransaction (UI approval hook)
//     checkApproval
//     finalizeAndSubmitTx (tx signing)
//       nonceLock.take (bottle neck to ensure atomic nonce)
//         fillInTxExtras (set fallback gasPrice, nonce, etc)
//         signTransaction (perform the signature)
//         publishTransaction (publish signed tx to network)
//
 
// Now uses Bluebird
promisify.Promise = require("bluebird")

inherits(HookedWalletSubprovider, Subprovider)

function HookedWalletSubprovider(opts){
  const self = this
  // control flow
  self.nonceLock = Semaphore(1)

  // data lookup
  if (opts.getAccounts) self.getAccounts = opts.getAccounts
  // high level override
  if (opts.processTransaction) self.processTransaction = opts.processTransaction
  if (opts.processMessage) self.processMessage = opts.processMessage
  if (opts.processPersonalMessage) self.processPersonalMessage = opts.processPersonalMessage
  if (opts.processTypedMessage) self.processTypedMessage = opts.processTypedMessage
  // approval hooks
  self.approveTransaction = opts.approveTransaction || self.autoApprove
  self.approveMessage = opts.approveMessage || self.autoApprove
  self.approvePersonalMessage = opts.approvePersonalMessage || self.autoApprove
  self.approveDecryptMessage = opts.approveDecryptMessage || self.autoApprove
  self.approveEncryptionPublicKey = opts.approveEncryptionPublicKey || self.autoApprove
  self.approveTypedMessage = opts.approveTypedMessage || self.autoApprove
  // actually perform the signature
  if (opts.signTransaction) self.signTransaction = opts.signTransaction  || mustProvideInConstructor('signTransaction')
  if (opts.signMessage) self.signMessage = opts.signMessage  || mustProvideInConstructor('signMessage')
  if (opts.signPersonalMessage) self.signPersonalMessage = opts.signPersonalMessage  || mustProvideInConstructor('signPersonalMessage')
  if (opts.decryptMessage) self.decryptMessage = opts.decryptMessage  || mustProvideInConstructor('decryptMessage')
  if (opts.encryptionPublicKey) self.encryptionPublicKey = opts.encryptionPublicKey  || mustProvideInConstructor('encryptionPublicKey')
  if (opts.signTypedMessage) self.signTypedMessage = opts.signTypedMessage  || mustProvideInConstructor('signTypedMessage')
  if (opts.recoverPersonalSignature) self.recoverPersonalSignature = opts.recoverPersonalSignature
  // publish to network
  if (opts.publishTransaction) self.publishTransaction = opts.publishTransaction
  // gas options
  self.estimateGas = opts.estimateGas || self.estimateGas
  self.getGasPrice = opts.getGasPrice || self.getGasPrice
}

HookedWalletSubprovider.prototype.handleRequest = function(payload, next, end){
  const self = this
  self._parityRequests = {}
  self._parityRequestCount = 0

  // switch statement is not block scoped
  // sp we cant repeat var declarations
  let txParams, msgParams, extraParams
  let message, address

  switch(payload.method) {

    case 'eth_coinbase':
      // process normally
      self.getAccounts(function(err, accounts){
        if (err) return end(err)
        let result = accounts[0] || null
        end(null, result)
      })
      return

    case 'eth_accounts':
      // process normally
      self.getAccounts(function(err, accounts){
        if (err) return end(err)
        end(null, accounts)
      })
      return
    
    case 'eth_sendRawTransaction':
      txParams = payload.params[0]
      return

    case 'eth_sendTransaction':
      txParams = payload.params[0]
      waterfall([
        (cb) => self.validateTransaction(txParams, cb),
        (cb) => self.processTransaction(txParams, cb),
      ], end)
      return

    case 'eth_signTransaction':
      txParams = payload.params[0]
      waterfall([
        (cb) => self.validateTransaction(txParams, cb),
        (cb) => self.processSignTransaction(txParams, cb),
      ], end)
      return

    case 'eth_sign':
      // process normally
      address = payload.params[0]
      message = payload.params[1]
      // non-standard "extraParams" to be appended to our "msgParams" obj
      // good place for metadata
      extraParams = payload.params[2] || {}
      msgParams = extend(extraParams, {
        from: address,
        data: message,
      })
      waterfall([
        (cb) => self.validateMessage(msgParams, cb),
        (cb) => self.processMessage(msgParams, cb),
      ], end)
      return

    case 'personal_sign':
      return (function(){
        // process normally
        const first = payload.params[0]
        const second = payload.params[1]

        // We initially incorrectly ordered these parameters.
        // To gracefully respect users who adopted this API early,
        // we are currently gracefully recovering from the wrong param order
        // when it is clearly identifiable.
        //
        // That means when the first param is definitely an address,
        // and the second param is definitely not, but is hex.
        if (resemblesData(second) && resemblesAddress(first)) {
          let warning = `The eth_personalSign method requires params ordered `
          warning += `[message, address]. This was previously handled incorrectly, `
          warning += `and has been corrected automatically. `
          warning += `Please switch this param order for smooth behavior in the future.`
          console.warn(warning)

          address = payload.params[0]
          message = payload.params[1]
        } else {
          message = payload.params[0]
          address = payload.params[1]
        }

        // non-standard "extraParams" to be appended to our "msgParams" obj
        // good place for metadata
        extraParams = payload.params[2] || {}
        msgParams = extend(extraParams, {
          from: address,
          data: message,
        })
        waterfall([
          (cb) => self.validatePersonalMessage(msgParams, cb),
          (cb) => self.processPersonalMessage(msgParams, cb),
        ], end)
      })()

    case 'eth_decryptMessage':
      return (function(){
        // process normally
        const first = payload.params[0]
        const second = payload.params[1]

        // We initially incorrectly ordered these parameters.
        // To gracefully respect users who adopted this API early,
        // we are currently gracefully recovering from the wrong param order
        // when it is clearly identifiable.
        //
        // That means when the first param is definitely an address,
        // and the second param is definitely not, but is hex.
        if (resemblesData(second) && resemblesAddress(first)) {
          let warning = `The eth_decryptMessage method requires params ordered `
          warning += `[message, address]. This was previously handled incorrectly, `
          warning += `and has been corrected automatically. `
          warning += `Please switch this param order for smooth behavior in the future.`
          console.warn(warning)

          address = payload.params[0]
          message = payload.params[1]
        } else {
          message = payload.params[0]
          address = payload.params[1]
        }

        // non-standard "extraParams" to be appended to our "msgParams" obj
        // good place for metadata
        extraParams = payload.params[2] || {}
        msgParams = extend(extraParams, {
          from: address,
          data: message,
        })
        waterfall([
          (cb) => self.validateDecryptMessage(msgParams, cb),
          (cb) => self.processDecryptMessage(msgParams, cb),
        ], end)
      })()
      
    case 'encryption_public_key':
      return (function(){
        const address = payload.params[0]
        
        waterfall([
          (cb) => self.validateEncryptionPublicKey(address, cb),
          (cb) => self.processEncryptionPublicKey(address, cb),
        ], end)
      })()
      
    case 'personal_ecRecover':
      return (function(){    
        message = payload.params[0]
        let signature = payload.params[1]
        // non-standard "extraParams" to be appended to our "msgParams" obj
        // good place for metadata
        extraParams = payload.params[2] || {}
        msgParams = extend(extraParams, {
          sig: signature,
          data: message,
        })
        self.recoverPersonalSignature(msgParams, end)
      })()

    case 'eth_signTypedData':
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4':
      return (function(){ 
        // process normally
      
        const first = payload.params[0]
        const second = payload.params[1]

        if (resemblesAddress(first)) {
          address = first
          message = second
        } else {
          message = first
          address = second
        }

        extraParams = payload.params[2] || {}
        msgParams = extend(extraParams, {
          from: address,
          data: message,
        })
        waterfall([
          (callb) => self.validateTypedMessage(msgParams, callb),
          (callb) => self.processTypedMessage(msgParams, callb),
        ], end)
      })()

    case 'parity_postTransaction':
      txParams = payload.params[0]
      self.parityPostTransaction(txParams, end)
      return

    case 'parity_postSign':
      address = payload.params[0]
      message = payload.params[1]
      self.parityPostSign(address, message, end)
      return

    case 'parity_checkRequest':
      return (function(){
        const requestId = payload.params[0]
        self.parityCheckRequest(requestId, end)
      })()

    case 'parity_defaultAccount':
      self.getAccounts(function(err, accounts){
        if (err) return end(err)
        const account = accounts[0] || null
        end(null, account)
      })
      return

    default:
      next()
      return

  }
}

//
// data lookup
//

HookedWalletSubprovider.prototype.getAccounts = function(cb) {
  cb(null, [])
}


//
// "process" high level flow
//

HookedWalletSubprovider.prototype.processTransaction = function(txParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveTransaction(txParams, callb),
    (didApprove, callb) => self.checkApproval('transaction', didApprove, callb),
    (callb) => self.finalizeAndSubmitTx(txParams, callb),
  ], cb)
}


HookedWalletSubprovider.prototype.processSignTransaction = function(txParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveTransaction(txParams, callb),
    (didApprove, callb) => self.checkApproval('transaction', didApprove, callb),
    (callb) => self.finalizeTx(txParams, callb),
  ], cb)
}

HookedWalletSubprovider.prototype.processMessage = function(msgParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveMessage(msgParams, callb),
    (didApprove, callb) => self.checkApproval('message', didApprove, callb),
    (callb) => self.signMessage(msgParams, callb),
  ], cb)
}

HookedWalletSubprovider.prototype.processPersonalMessage = function(msgParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approvePersonalMessage(msgParams, callb),
    (didApprove, callb) => self.checkApproval('message', didApprove, callb),
    (callb) => self.signPersonalMessage(msgParams, callb),
  ], cb)
}

HookedWalletSubprovider.prototype.processDecryptMessage = function(msgParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveDecryptMessage(msgParams, callb),
    (didApprove, callb) => self.checkApproval('decryptMessage', didApprove, callb),
    (callb) => self.decryptMessage(msgParams, callb),
  ], cb)
}

HookedWalletSubprovider.prototype.processEncryptionPublicKey = function(msgParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveEncryptionPublicKey(msgParams, callb),
    (didApprove, callb) => self.checkApproval('encryptionPublicKey', didApprove, callb),
    (callb) => self.encryptionPublicKey(msgParams, callb),
  ], cb)
}

HookedWalletSubprovider.prototype.processTypedMessage = function(msgParams, cb) {
  const self = this
  waterfall([
    (callb) => self.approveTypedMessage(msgParams, callb),
    (didApprove, callb) => self.checkApproval('message', didApprove, callb),
    (callb) => self.signTypedMessage(msgParams, callb),
  ], cb)
}

//
// approval
//

HookedWalletSubprovider.prototype.autoApprove = function(txParams, cb) {
  cb(null, true)
}

HookedWalletSubprovider.prototype.checkApproval = function(type, didApprove, cb) {
  cb( didApprove ? null : new Error('User denied '+type+' signature.'))
}

//
// parity
//

HookedWalletSubprovider.prototype.parityPostTransaction = function(txParams, cb) {
  const self = this

  // get next id
  const count = self._parityRequestCount
  const reqId = `0x${count.toString(16)}`
  self._parityRequestCount++

  self.emitPayload({
    method: 'eth_sendTransaction',
    params: [txParams],
  }, function(error, res){
    if (error) {
      self._parityRequests[reqId] = { error }
      return
    }
    const txHash = res.result
    self._parityRequests[reqId] = txHash
  })

  cb(null, reqId)
}


HookedWalletSubprovider.prototype.parityPostSign = function(address, message, cb) {
  const self = this

  // get next id
  const count = self._parityRequestCount
  const reqId = `0x${count.toString(16)}`
  self._parityRequestCount++

  self.emitPayload({
    method: 'eth_sign',
    params: [address, message],
  }, function(error, res){
    if (error) {
      self._parityRequests[reqId] = { error }
      return
    }
    const result = res.result
    self._parityRequests[reqId] = result
  })

  cb(null, reqId)
}

HookedWalletSubprovider.prototype.parityCheckRequest = function(reqId, cb) {
  const self = this
  const result = self._parityRequests[reqId] || null
  // tx not handled yet
  if (!result) return cb(null, null)
  // tx was rejected (or other error)
  if (result.error) return cb(result.error)
  // tx sent
  cb(null, result)
}

//
// signature and recovery
//

HookedWalletSubprovider.prototype.recoverPersonalSignature = function(msgParams, cb) {
  let senderHex
  try {
    senderHex = sigUtil.recoverPersonalSignature(msgParams)
  } catch (err) {
    return cb(err)
  }
  cb(null, senderHex)
}

//
// validation
//

HookedWalletSubprovider.prototype.validateTransaction = function(txParams, cb){
  const self = this
  // shortcut: undefined sender is invalid
  if (txParams.from === undefined) return cb(new Error(`Undefined address - from address required to sign transaction.`))
  self.validateSender(txParams.from, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to sign transaction for this address: "${txParams.from}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validateMessage = function(msgParams, cb){
  const self = this
  if (msgParams.from === undefined) return cb(new Error(`Undefined address - from address required to sign message.`))
  self.validateSender(msgParams.from, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to sign message for this address: "${msgParams.from}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validatePersonalMessage = function(msgParams, cb){
  const self = this
  if (msgParams.from === undefined) return cb(new Error(`Undefined address - from address required to sign personal message.`))
  if (msgParams.data === undefined) return cb(new Error(`Undefined message - message required to sign personal message.`))
  if (!isValidHex(msgParams.data)) return cb(new Error(`HookedWalletSubprovider - validateMessage - message was not encoded as hex.`))
  self.validateSender(msgParams.from, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to sign message for this address: "${msgParams.from}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validateDecryptMessage = function(msgParams, cb){
  const self = this
  if (msgParams.from === undefined) return cb(new Error(`Undefined address - from address required to decrypt message.`))
  if (msgParams.data === undefined) return cb(new Error(`Undefined message - message required to decrypt message.`))
  if (!isValidHex(msgParams.data)) return cb(new Error(`HookedWalletSubprovider - validateDecryptMessage - message was not encoded as hex.`))
  self.validateSender(msgParams.from, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to decrypt message for this address: "${msgParams.from}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validateEncryptionPublicKey = function(address, cb){
  const self = this

  self.validateSender(address, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to obtain encryption public key for this address: "${address}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validateTypedMessage = function(msgParams, cb){
  if (msgParams.from === undefined) return cb(new Error(`Undefined address - from address required to sign typed data.`))
  if (msgParams.data === undefined) return cb(new Error(`Undefined data - message required to sign typed data.`))
  this.validateSender(msgParams.from, function(err, senderIsValid){
    if (err) return cb(err)
    if (!senderIsValid) return cb(new Error(`Unknown address - unable to sign message for this address: "${msgParams.from}"`))
    cb()
  })
}

HookedWalletSubprovider.prototype.validateSender = function(senderAddress, cb){
  const self = this
  // shortcut: undefined sender is invalid
  if (!senderAddress) return cb(null, false)
  self.getAccounts(function(err, accounts){
    if (err) return cb(err)
    const senderIsValid = (accounts.map(toLowerCase).indexOf(senderAddress.toLowerCase()) !== -1)
    cb(null, senderIsValid)
  })
}

//
// tx helpers
//

HookedWalletSubprovider.prototype.finalizeAndSubmitTx = function(txParams, cb) {
  console.log('finalizeAndSubmitTx')
  const self = this
  // can only allow one tx to pass through this flow at a time
  // so we can atomically consume a nonce
  self.nonceLock.take(function(){
    waterfall([
      (callb) => self.fillInTxExtras(txParams, callb),
      (params, callb) => self.signTransaction(params, callb),
      (params, callb) => self.publishTransaction(params, callb),
    ], function(err, txHash){
      self.nonceLock.leave()
      if (err) return cb(err)
      cb(null, txHash)
    })
  })
}

HookedWalletSubprovider.prototype.finalizeTx = function(txParams, cb) {
  console.log('finalizeTx')
  const self = this
  // can only allow one tx to pass through this flow at a time
  // so we can atomically consume a nonce
  self.nonceLock.take(function(){
    waterfall([
      (callb) => self.fillInTxExtras(txParams, callb),
      (params, callb) => self.signTransaction(params, callb),
    ], function(err, signedTx){
      self.nonceLock.leave()
      if (err) return cb(err)
      cb(null, {raw: signedTx, tx: txParams})
    })
  })
}

HookedWalletSubprovider.prototype.publishTransaction = function(rawTx, cb) {
  console.log('publishTransaction')
  const self = this
  self.emitPayload({
    method: 'eth_sendRawTransaction',
    params: [rawTx],
  }, function(err, res){
    if (err) return cb(err)
    cb(null, res.result)
  })
}

HookedWalletSubprovider.prototype.estimateGas = function(txParams, cb) {
  const self = this
  estimateGas(self.engine, txParams, cb)
}

HookedWalletSubprovider.prototype.getGasPrice = function(cb) {
  const self = this
  self.emitPayload({ method: 'eth_gasPrice', params: [] }, function (err, res) {
    if (err) return cb(err)
    cb(null, res.result)
  })
}

HookedWalletSubprovider.prototype.fillInTxExtras = function(txParams, cb){
  console.log('fillInTxExtras')
  const self = this
  const {from, gasPrice, nonce, gas} = txParams

  let ta = new Array(3)
  ta.push(!gasPrice ? 
    promisify((cb) => self.getGasPrice(cb)) : 
    Promise.resolve(gasPrice))
  ta.push(!nonce ? 
    promisify((cb) => self.emitPayload({ method: 'eth_getTransactionCount', 
            params: [from, 'pending'] }, cb)) : 
    Promise.resolve(nonce))
  ta.push(!gas ? 
    promisify((cb) => self.estimateGas(cloneTxParams(txParams), cb)) : 
    Promise.resolve(gas))
  
  // do it all in parallel
  Promise.all(ta).then(
    (result) => {
      result.map((p, i) => {
        switch(i) {
          case 0: txParams.gasPrice = p
            break
          case 1: txParams.nonce = p
            break
          case 2: txParams.gas = p
            break
          default:
        }
      })
      cb(null, txParams)
    },
    (reason) => {
      cb(reason)
    }
  )

}

// util

// we use this to clean any custom params from the txParams
function cloneTxParams(txParams){
  return {
    from: txParams.from,
    to: txParams.to,
    value: txParams.value,
    data: txParams.data,
    gas: txParams.gas,
    gasPrice: txParams.gasPrice,
    nonce: txParams.nonce,
  }
}

function toLowerCase(string){
  return string.toLowerCase()
}

function resemblesAddress (string) {
  const fixed = ethUtil.addHexPrefix(string)
  const isValid = ethUtil.isValidAddress(fixed)
  return isValid
}

// Returns true if resembles hex data
// but definitely not a valid address.
function resemblesData (string) {
  const fixed = ethUtil.addHexPrefix(string)
  const isValidAddress = ethUtil.isValidAddress(fixed)
  return !isValidAddress && isValidHex(string)
}

function isValidHex(data) {
  const isString = typeof data === 'string'
  if (!isString) return false
  const isHexPrefixed = data.slice(0,2) === '0x'
  if (!isHexPrefixed) return false
  const nonPrefixed = data.slice(2)
  const isValid = nonPrefixed.match(hexRegex)
  return isValid
}

function mustProvideInConstructor(methodName) {
  return function(params, cb) {
    cb(new Error('ProviderEngine - HookedWalletSubprovider - Must provide "' + methodName + '" fn in constructor options'))
  }
}
