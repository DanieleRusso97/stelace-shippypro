const ShippyPro = require('shippypro');
const debug = require('debug')('stelace:integrations:shippypro');
const _ = require('lodash');
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

		const { secretApiKey } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!secretApiKey)
			throw createError(403, 'ShippyPro secret API key not configured');

		const shippypro = ShippyPro(secretApiKey);

		if (typeof _.get(shippypro, method) !== 'function') {
			throw createError(400, 'ShippyPro method not found', {
				public: { method },
			});
		}

		try {
			// awaiting to handle error in catch block
			return await _.invoke(shippypro, method, ...args); // promise
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

		if (_.isEmpty(rawBody))
			throw createError(400, 'Event object body expected');

		const req = {
			_requestId,
			platformId,
			env,
		};

		const privateConfig = await configRequester.communicate(req)({
			type: '_getConfig',
			access: 'private',
		});

		const { secretApiKey, webhookSecret } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!secretApiKey)
			throw createError(403, 'ShippyPro API key not configured');
		if (!webhookSecret)
			throw createError(403, 'ShippyPro Webhook secret not configured');

		const shippypro = ShippyPro(secretApiKey);

		let event;

		// Verify ShippyPro webhook signature
		// https://shippypro.com/docs/webhooks/signatures
		try {
			event = shippypro.webhooks.constructEvent(
				rawBody,
				shippyproSignature,
				webhookSecret,
			);
		} catch (err) {
			throw createError(403);
		}

		// prefix prevents overlapping with other event types
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
		// https://shippypro.com/docs/webhooks/best-practices#duplicate-events
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
				// https://shippypro.com/docs/api/events/types
				// No ShippyPro event name currently has two underscores '__', which would cause an error
				type,
				objectId: event.id, // just a convention to easily retrieve events, objectId being indexed
				emitterId: 'shippypro',
				metadata: event,
			},
		});

		return { success: true };
	}
};
