module.exports = {
	env: {
		node: true,
	},

	extends: 'standard',
	plugins: ['standard', 'promise'],

	rules: {
		'comma-dangle': 'off',
		indent: ['error', 'tab'],
		'no-tabs': 0,
		'space-before-function-paren': 0,
		semi: ['error', 'always'],
	},
};
