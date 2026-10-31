// OpenAPI 3.1 description of src/api.js, served at /openapi.json (and rendered at /docs).

const ShopState = {
  type: 'object',
  properties: {
    status: { type: ['string', 'null'], enum: ['open', 'closed', null], description: 'null until the status has been set once.' },
    since: { type: ['string', 'null'], format: 'date-time', description: 'When the current status was set (UTC).' },
    note: { type: ['string', 'null'], description: 'The note sent with the last change, if any.' },
    by: { type: ['string', 'null'], description: 'Who changed it: a Discord display name, or "API".' },
  },
  required: ['status', 'since', 'note', 'by'],
};

const ErrorBody = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
};

const errorResponse = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

export const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Awake shop status API',
    version: '1.0.0',
    description:
      'Read or change whether Awake is open. A change does exactly what `/shop open|closed` does in Discord: it posts the announcement (pinging the updates role), renames the status channel, swaps the server banner and sets the bot\'s status.',
  },
  servers: [{ url: 'https://awake-discord-bot.fly.dev' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'The SHOP_API_TOKEN secret.' } },
    schemas: { ShopState, Error: ErrorBody },
  },
  paths: {
    '/api/shop/status': {
      get: {
        summary: 'Current shop status',
        operationId: 'getShopStatus',
        security: [],
        responses: {
          200: { description: 'The current status.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ShopState' } } } },
        },
      },
      post: {
        summary: 'Open or close the shop',
        operationId: 'setShopStatus',
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['open', 'closed'] },
                  note: { type: 'string', maxLength: 500, description: 'Optional line shown under the announcement.' },
                },
                required: ['status'],
              },
              examples: {
                open: { value: { status: 'open' } },
                closedWithNote: { value: { status: 'closed', note: 'Closing early today for a private event' } },
              },
            },
          },
        },
        responses: {
          200: {
            description:
              'Done. `changed` is false when the shop was already in that state: nothing is posted again, so repeating a call is safe.',
            content: {
              'application/json': {
                schema: { allOf: [{ type: 'object', properties: { changed: { type: 'boolean' } }, required: ['changed'] }, { $ref: '#/components/schemas/ShopState' }] },
              },
            },
          },
          400: errorResponse('Invalid body: status must be "open" or "closed"; note at most 500 characters.'),
          401: errorResponse('Missing or wrong token.'),
          429: errorResponse('More than 10 changes in a minute.'),
          503: errorResponse('The bot is still connecting to Discord (retry shortly), or no token is configured.'),
        },
      },
    },
    '/health': {
      get: {
        summary: 'Health check',
        operationId: 'health',
        security: [],
        responses: { 200: { description: 'The server is up; `discord` says whether the bot is connected.' } },
      },
    },
  },
};
