'use strict'

const debug = require('debug')('gemini:client')
const {parse: parseUrl} = require('url')
const pem = require('pem')
const {pipeline: pipe} = require('stream')
const connect = require('./connect')
const createParser = require('./lib/response-parser')
const {
	DEFAULT_PORT,
	ALPN_ID,
} = require('./lib/util')
const {CODES, MESSAGES} = require('./lib/statuses')

const HOUR = 60 * 60 * 1000

const _request = (pathOrUrl, opt, ctx, cb) => {
	debug('_request', pathOrUrl, ctx, opt)

	const {
		verifyAlpnId,
	} = {
		verifyAlpnId: alpnId => alpnId ? (alpnId === ALPN_ID) : true,
		...opt,
	}

	connect(opt, (err, socket) => {
		if (err) return cb(err)
		debug('connection', socket)

		if (verifyAlpnId(socket.alpnProtocol) !== true) {
			socket.destroy()
			return cb(new Error('invalid or missing ALPN protocol'))
		}

		const res = createParser()
		pipe(
			socket,
			res,
			(err) => {
				if (err) debug('error receiving response', err)
				// Control over the socket has been given to the caller
				// already, so we swallow the error here.
				if (!timeout) return;
				if (!err) cb(new Error('socket closed while waiting for header'))
			},
		)

		const reportTimeout = () => {
			socket.destroy(new Error('timeout waiting for header'))
		}
		let timeout = setTimeout(reportTimeout, opt.connectTimeout)

		res.once('header', (header) => {
			clearTimeout(timeout)
			timeout = null
			debug('received header', header)

			// prepare res
			res.socket = socket
			res.statusCode = header.statusCode
			res.statusMessage = header.statusMsg
			res.meta = header.meta // todo: change name
			// todo: res.abort(), res.destroy()

			cb(null, res)
			socket.emit('response', res)
		})

		// send request
		socket.end(pathOrUrl + '\r\n')
	})
}

// https://gemini.circumlunar.space/docs/spec-spec.txt, 1.4.3
// > Transient certificates are limited in scope to a particular domain.
// > Transient certificates MUST NOT be reused across different domains.
// >
// > Transient certificates MUST be permanently deleted when the matching
// > server issues a response with a status code of 21 (see Appendix 1
// > below).
// >
// > Transient certificates MUST be permanently deleted when the client
// > process terminates.
// >
// > Transient certificates SHOULD be permanently deleted after not having
// > been used for more than 24 hours.
const certs = new Map()
const defaultClientCertStore = {
	get: (host, cb) => {
		// reuse?
		if (certs.has(host)) {
			const {tCreated, cert, key} = certs.get(host)
			if ((Date.now() - tCreated) <= 24 * HOUR) {
				return cb(null, {tCreated, cert, key})
			}
			certs.delete(host) // expired
		}

		// generate new
		const tCreated = Date.now()
		pem.createCertificate({
			days: 1, selfSigned: true
		}, (err, {certificate: cert, clientKey: key}) => {
			if (err) return cb(err)

			certs.set(host, {tCreated, cert, key})
			return cb(null, {tCreated, cert, key})
		})
	},
	delete: (host, cb) => {
		const has = certs.has(host)
		if (has) certs.delete(host)
		cb(null, has)
	},
}

const errFromStatusCode = (res, msg = null) => {
	const err = new Error(msg || MESSAGES[res.statusCode] || 'unknown error')
	err.statusCode = res.statusCode
	err.res = res
	return err
}

const sendGeminiRequest = (pathOrUrl, opt, done) => {
	if (typeof pathOrUrl !== 'string' || !pathOrUrl) {
		throw new Error('pathOrUrl must be a string & not empty')
	}
	if (typeof opt === 'function') {
		done = opt
		opt = {}
	}
	const {
		followRedirects,
		useClientCerts,
		letUserConfirmClientCertUsage,
		clientCertStore,
		connectTimeout,
		tlsOpt,
		verifyAlpnId,
	} = {
		followRedirects: false,
		// https://gemini.circumlunar.space/docs/spec-spec.txt, 1.4.3
		// > Interactive clients for human users MUST inform users that such a
		// > session has been requested and require the user to approve
		// > generation of such a certificate.  Transient certificates MUST NOT
		// > be generated automatically.
		// >
		// > Transient certificates are limited in scope to a particular domain.
		// > Transient certificates MUST NOT be reused across different domains.
		useClientCerts: false,
		letUserConfirmClientCertUsage: null,
		clientCertStore: defaultClientCertStore,
		connectTimeout: 60 * 1000, // 60s
		tlsOpt: {},
		...opt,
	}

	const shouldFollowRedirect = 'function' === typeof followRedirects
		? followRedirects
		: () => followRedirects

	if (useClientCerts) {
		if (typeof letUserConfirmClientCertUsage !== 'function') {
			throw new Error('letUserConfirmClientCertUsage must be a function')
		}
		if (!clientCertStore) throw new Error('invalid clientCertStore')
		if (typeof clientCertStore.get !== 'function') {
			throw new Error('clientCertStore.get must be a function')
		}
		if (typeof clientCertStore.delete !== 'function') {
			throw new Error('clientCertStore.delete must be a function')
		}
	}

	const target = parseUrl(pathOrUrl)
	let reqOpt = {
		hostname: target.hostname || 'localhost',
		port: target.port || DEFAULT_PORT,
		connectTimeout,
		tlsOpt,
	}

	if (verifyAlpnId) reqOpt.verifyAlpnId = verifyAlpnId

	let ctx = {
		redirectsFollowed: 0,
	}

	let cb = (err, res) => {
		if (err) return done(err)

		// handle redirect
		if ((
			res.statusCode === CODES.REDIRECT_TEMPORARY ||
			res.statusCode === CODES.REDIRECT_PERMANENT
		) && shouldFollowRedirect(ctx.redirectsFollowed + 1, res)) {
			ctx = {
				...ctx,
				redirectsFollowed: ctx.redirectsFollowed + 1
			}
			debug('following redirect nr', ctx.redirectsFollowed)

			// todo: handle empty res.meta
			const newTarget = parseUrl(res.meta)
			reqOpt = {
				...reqOpt,
				hostname: newTarget.hostname || reqOpt.hostname,
				port: newTarget.port || reqOpt.port,
			}
			pathOrUrl = res.meta
			_request(res.meta, reqOpt, ctx, cb)
			return;
		}

		// report server-sent errors
		// > The contents of <META> may provide additional information
		// > on certificate requirements or the reason a certificate
		// > was rejected.
		if (
			res.statusCode === CODES.CERTIFICATE_NOT_ACCEPTED ||
			res.statusCode === CODES.FUTURE_CERT_REJECTED ||
			res.statusCode === CODES.EXPIRED_CERT_REJECTED
		) return done(errFromStatusCode(res, res.meta))

		// handle server-sent client cert prompt
		if (
			res.statusCode === CODES.CLIENT_CERT_REQUIRED ||
			res.statusCode === CODES.TRANSIENT_CERT_REQUESTED ||
			res.statusCode === CODES.AUTHORISED_CERT_REQUIRED
		) {
			const origin = reqOpt.hostname + ':' + reqOpt.port
			letUserConfirmClientCertUsage({
				host: origin,
				reason: res.meta,
			}, (confirmed) => {
				if (confirmed !== true) {
					const err = new Error('server request client cert, but user rejected')
					err.res = res
					return done(err)
				}

				clientCertStore.get(origin, (err, {cert, key}) => {
					if (err) return done(err)

					_request(pathOrUrl, {
						...reqOpt,
						cert, key,
					}, ctx, cb)
				})
			})
			return;
		}

		done(null, res)
	}

	_request(pathOrUrl, reqOpt, ctx, cb)
}

module.exports = sendGeminiRequest
