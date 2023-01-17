const debug = require('debug')('stelace:integrations:shippypro');
const _ = require('lodash');
const axios = require('axios');
const { parsePublicPlatformId } = require('stelace-util-keys');

module.exports = function createService(deps) {
	const {
		createError,
		communication: { stelaceApiRequest },

		configRequester,
	} = deps;

	return {
		sendRequest,
		webhook,
	};

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

		try {
			return await axios.post(
				URI,
				{ Method: method, Params: args[0] },
				{
					auth: {
						username: KEY,
					},
				},
			);
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
		// shippyproSignature,
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

		const { KEY } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!KEY) {
			throw createError(403, 'ShippyPro API key not configured');
		}

		let event;

		// try {
		// 	event = shippypro.webhooks.constructEvent(
		// 		rawBody,
		// 		shippyproSignature,
		// 		webhookSecret,
		// 	);
		// } catch (err) {
		// 	throw createError(403);
		// }

		const type = `shippypro_${event.type}`;
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
