const debug = require('debug')('stelace:integrations:shippypro');
const _ = require('lodash');
const axios = require('axios');
const { parsePublicPlatformId } = require('stelace-util-keys');

module.exports = function createService(deps) {
	const {
		createError,
		communication: { stelaceApiRequest },

		getCurrentUserId,
		configRequester,
		transactionRequester,
	} = deps;

	return {
		sendRequest,
		webhook,
	};

	async function _getTransaction(req, transactionId) {
		const transaction = await transactionRequester.communicate(req)({
			type: 'read',
			transactionId: transactionId,
		});
		return transaction;
	}

	async function sendRequest(req) {
		const { env, method, args = [{}] } = req;

		const privateConfig = await configRequester.communicate(req)({
			type: '_getConfig',
			access: 'private',
		});

		const { KEY, URI } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!KEY) throw createError(403, 'ShippyPro API key not configured');

		// const shippypro = ShippyPro(secretApiKey);

		// if (typeof _.get(shippypro, method) !== 'function') {
		// 	throw createError(400, 'ShippyPro method not found', {
		// 		public: { method },
		// 	});
		// }
		const params = args[0];
		const currentUser = getCurrentUserId(req);

		const allowedMethods = ['GetRates', 'Ship'];

		let transaction;

		if (params.TransactionID) {
			const transactionId = params.TransactionID || undefined;
			transaction = await _getTransaction(req, transactionId);
		}

		if (!req._matchedPermissions['integrations:read_write:shippypro']) {
			if (!allowedMethods.includes(method)) throw createError(403);

			if (transaction) {
				if (method === 'Ship') {
					if (currentUser !== transaction.ownerId) {
						throw createError(403);
					}
				}
			}
		}

		try {
			return (
				await axios.post(
					URI,
					{ Method: method, Params: args[0] },
					{
						auth: {
							username: KEY,
						},
					},
				)
			).data;
		} catch (err) {
			const errorMessage = 'ShippyPro error';
			const errObject = { expose: true };

			const reveal = !(
				process.env.NODE_ENV === 'production' && env === 'live'
			);
			const errDetails = {
				shippyproMethod: method,
				shippyproError: err,
			};
			if (reveal) _.set(errObject, 'public', errDetails);

			throw createError(err.http_status_code, errorMessage, errObject);
		}
	}

	async function webhook({
		_requestId,
		shippyproSignature,
		rawBody,
		publicPlatformId,
	}) {
		debug('ShippyPro integration: webhook event %O', rawBody);

		const { hasValidFormat, platformId, env } =
			parsePublicPlatformId(publicPlatformId);
		if (!hasValidFormat) throw createError(403);

		if (_.isEmpty(rawBody)) {
			throw createError(400, 'Event object body expected');
		}

		const req = {
			_requestId,
			platformId,
			env,
		};

		const privateConfig = await configRequester.communicate(req)({
			type: '_getConfig',
			access: 'private',
		});

		const { KEY, WEBHOOK_KEY } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!KEY) {
			throw createError(403, 'ShippyPro API key not configured');
		}
		if (!WEBHOOK_KEY) {
			throw createError(403, 'ShippyPro WEBHOOK key not configured');
		}

		if (WEBHOOK_KEY !== shippyproSignature) {
			throw createError(403);
		}

		const event = {
			id: req._requestId,
			...rawBody,
		};

		const type = `shippypro_${event.Event}`;
		const params = {
			type,
			orderBy: 'createdDate',
			order: 'desc',
			page: 1,
		};

		const { results: sameEvents } = await stelaceApiRequest('/events', {
			platformId,
			env,
			payload: {
				objectId: event.id,
				nbResultsPerPage: 1,
				...params,
			},
		});

		// ShippyPro webhooks may send same events multiple times
		if (sameEvents.length) {
			debug(
				'ShippyPro integration: idempotency check with event id: %O',
				sameEvents,
			);
		}

		await stelaceApiRequest('/events', {
			platformId,
			env,
			method: 'POST',
			payload: {
				type,
				objectId: event.id,
				emitterId: 'shippypro',
				metadata: event,
			},
		});

		return { success: true };
	}
};
