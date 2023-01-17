const createService = require('../services/shippypro');

let shippypro;
let deps = {};

function init(server, { middlewares, helpers } = {}) {
	const {
		checkPermissions,
		// restifyAuthorizationParser
	} = middlewares;
	const { wrapAction, getRequestContext } = helpers;

	server.post(
		{
			name: 'shippypro.pluginRequest',
			path: '/integrations/shippypro/request',
		},
		checkPermissions([
			'integrations:read_write:shippypro',
			'integrations:read_write:all', // does not currently exist
		]),
		wrapAction(async (req, res) => {
			let ctx = getRequestContext(req);

			const { args, method } = req.body;
			ctx = Object.assign({}, ctx, { args, method });

			return shippypro.sendRequest(ctx);
		}),
	);

	server.post(
		{
			name: 'shippypro.webhooks',
			path: '/integrations/shippypro/webhooks/:publicPlatformId',
			manualAuth: true,
		},
		// restifyAuthorizationParser,
		wrapAction(async (req, res) => {
			const { publicPlatformId } = req.params;
			const shippyproSignature = req.headers['shippypro-signature'];

			return shippypro.webhook({
				_requestId: req._requestId,
				publicPlatformId,
				shippyproSignature,
				rawBody: req.rawBody,
				deps,
			});
		}),
	);
}

function start(startParams) {
	deps = Object.assign({}, startParams);

	const {
		communication: { getRequester },
	} = deps;

	const configRequester = getRequester({
		name: 'ShippyPro service > Config Requester',
		key: 'config',
	});

	const transactionRequester = getRequester({
		name: 'Shippypro service > Transaction Requester',
		key: 'transaction',
	});

	Object.assign(deps, {
		configRequester,
		transactionRequester,
	});

	shippypro = createService(deps);
}

function stop() {
	const { configRequester, transactionRequester } = deps;

	configRequester.close();
	transactionRequester.close();

	deps = null;
}

module.exports = {
	init,
	start,
	stop,
};
