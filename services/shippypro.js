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
		userRequester,
	} = deps;

	return {
		sendRequest,
		webhook,
	};

	async function _getConfig(req, isPrivate) {
		const config = await configRequester.communicate(req)({
			type: '_getConfig',
			access: isPrivate ? 'private' : 'default',
		});
		return config;
	}

	async function _getTransaction(req, transactionId) {
		const transaction = await transactionRequester.communicate(req)({
			type: 'read',
			transactionId: transactionId,
		});
		return transaction;
	}

	async function _updateTransaction(req, transactionId, args) {
		let transaction;
		try {
			transaction = await transactionRequester.communicate(req)({
				type: 'update',
				transactionId,
				...args,
			});
		} catch (err) {
			console.log(err);
		}
		return transaction;
	}

	async function _getUser(req, userId) {
		const user = await userRequester.communicate(req)({
			type: 'read',
			userId: userId,
		});
		return user;
	}

	async function _invokeShippypro(URI, KEY, method, args, env) {
		try {
			return (
				await axios.post(
					URI,
					{ Method: method, Params: args },
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

	async function sendRequest(req) {
		const { env, method, args = [{}] } = req;

		const privateConfig = await _getConfig(req, true);
		const config = await _getConfig(req);

		console.log('confs: ', privateConfig, config);

		const { KEY, URI } = _.get(
			privateConfig,
			'stelace.integrations.shippypro',
			{},
		);
		if (!KEY) throw createError(403, 'ShippyPro API key not configured');

		const currentUser = getCurrentUserId(req);
		console.log('curr user: ', currentUser);

		const allowedMethods = ['Ship'];

		console.log('hereeeee logged shippypro');
		if (
			!allowedMethods.includes(method) &&
			!req._matchedPermissions['integrations:read_write:shippypro']
		) {
			throw createError(403);
		}

		if (method === 'Ship') {
			/*
					args = [{
						transactionId: string;
					}]
				*/

			const params = args[0];

			if (!params.transactionId) {
				throw createError(400, 'Mangopay args not acceptable');
			}

			const transaction = await _getTransaction(
				req,
				params.transactionId,
			);

			console.log('transaction: ', transaction);

			if (!transaction) {
				throw createError(404, 'Transaction not exist');
			}

			if (currentUser !== transaction.ownerId) {
				throw createError(403);
			}

			const shippyproOrderId = _.get(
				transaction,
				'platformData.shippypro.orderId',
				undefined,
			);

			if (shippyproOrderId) {
				return _invokeShippypro(
					URI,
					KEY,
					'GetOrder',
					{
						OrderID: shippyproOrderId,
					},
					env,
				);
			} else {
				const owner = await _getUser(req, transaction.ownerId);
				const taker = await _getUser(req, transaction.takerId);
				console.log('users: ', owner, taker);
				if (!owner || !taker) {
					throw createError(400, 'Users not exist');
				}

				const carrierSelected =
					_.get(transaction, 'metadata.carrier') ||
					config.custom.defaultCarrier;

				console.log('car sel: ', carrierSelected);
				const carrierPricing =
					config.custom.shipping[carrierSelected].pricing;

				console.log(carrierPricing);
				const carrierPricingInfo = carrierPricing.find(
					packSize =>
						packSize.size ===
						_.get(
							transaction,
							'assetSnapshot.metadata.packagingSize',
						),
				);

				console.log('car pr inf: ', carrierPricingInfo);

				const ownerAddress =
					_.get(
						owner,
						'platformData._private.verified.individualInfo.address',
					) ||
					_.get(
						owner,
						'platformData._private.verified.companyInfo.address',
					);

				const transactionMetadata = transaction.metadata;

				if (_.get(transactionMetadata, 'address')) {
					const shippingInfo = {
						from_address: {
							name: owner.firstname + ' ' + owner.lastname,
							company:
								_.get(
									owner,
									'platformData._private.verified.companyInfo.businessName',
								) || '',
							state: '',
							country: ownerAddress.country,
							city: ownerAddress.city,
							email: owner.email || owner.username,
							phone: _.get(
								owner,
								'platformData._private.verified.individualInfo.phone',
							),
							zip: ownerAddress.zip,
							street1:
								ownerAddress.address +
								' ' +
								ownerAddress.streetNumber,
							street2: ownerAddress.address2,
						},
						to_address: {
							name:
								_.get(transaction, 'metadata.firstName') ||
								taker.firstname +
									' ' +
									_.get(transaction, 'metadata.lastName') ||
								taker.lastname,
							company: '',
							state: '',
							country: transactionMetadata.address.Country,
							city: transactionMetadata.address.City,
							email: taker.email || taker.username,
							phone: transactionMetadata.phone,
							zip: transactionMetadata.address.PostalCode,
							street1: transactionMetadata.address.AddressLine1,
							street2: transactionMetadata.address.AddressLine2,
						},
						parcels: [carrierPricingInfo.dimensions],
					};

					console.log('ship info: ', shippingInfo);

					const shippingRates = await _invokeShippypro(
						URI,
						KEY,
						'GetRates',
						{ ...shippingInfo, ShippingService: 'Standard' },
						env,
					);

					const carrierRates = shippingRates.Rates.find(
						carrierData => carrierData.carrier === carrierSelected,
					);

					const shipping = await _invokeShippypro(
						URI,
						KEY,
						'Ship',
						{
							...shippingInfo,
							CarrierName: carrierRates.carrier,
							CarrierService: carrierRates.service,
							CarrierID: parseInt(carrierRates.carrier_id),
							OrderID: carrierRates.order_id,
							RateID: carrierRates.rate_id,
							Async: false,
							TransactionID: transaction.id,
							description: transaction.assetSnapshot.name,
							ShipmentCost:
								_.get(
									transaction,
									'platformData.shippingFare',
									0,
								) / 100,
							ShipmentAmountPaid:
								(_.get(
									transaction,
									'platformData.shippingFare',
									0,
								) -
									_.get(
										transaction,
										'platformData.transferToShipping',
										0,
									)) /
								100,
							ShipmentCostCurrency: transaction.currency,
							LabelType: 'PDF',
							ContentDescription: transaction.assetSnapshot.name,
							TotalValue: `${
								(transaction.takerAmount +
									carrierPricingInfo.price +
									config.custom.additionalPricing
										.takerFeesFixed) /
								100
							} ${transaction.currency}`,
						},
						env,
					);

					if (shipping.NewOrderID) {
						await _updateTransaction(req, transaction.id, {
							platformData: {
								tracking: {
									number: shipping.TrackingNumber,
									link: shipping.TrackingExternalLink,
								},
								shippypro: {
									orderId: shipping.NewOrderID,
									labelURL: Array.isArray(shipping.LabelURL)
										? shipping.LabelURL[0]
										: shipping.LabelURL,
								},
							},
						});
					}

					return shipping;
				} else {
					throw createError(400, 'Transaction does not have address');
				}
			}
		}

		if (req._matchedPermissions['integrations:read_write:shippypro']) {
			await _invokeShippypro(URI, KEY, method, args, env);
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
			...JSON.parse(rawBody),
		};

		console.log('event webhook: ', JSON.parse(rawBody));

		const type = `shippypro_${event.Event}`;
		const params = {
			type,
			orderBy: 'createdDate',
			order: 'desc',
			page: 1,
		};

		console.log('event type: ', type);
		console.log('event params: ', params);

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
