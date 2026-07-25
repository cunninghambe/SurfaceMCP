import Fastify, { type FastifyInstance } from 'fastify';

const fastify: FastifyInstance = Fastify();

// Shorthand + options object: GET with a querystring JSON Schema and a declared
// 200 response schema (Fastify enforces response serialization, so this is the
// highest-fidelity response typing available).
fastify.get(
  '/api/items',
  {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          cursor: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  price: { type: 'number' },
                },
              },
            },
            total: { type: 'integer' },
          },
        },
      },
    },
  },
  async (request) => {
    return { items: [], query: request.query };
  }
);

// Shorthand + options object: POST with a body JSON Schema, and a 201-only
// response map (no 200 key — status selection has to fall through to it).
fastify.post(
  '/api/items',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'price'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          price: { type: 'number', minimum: 0 },
          category: { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
          },
        },
        400: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  },
  async (request, reply) => {
    reply.code(201);
    return { created: request.body };
  }
);

// Shorthand, param route, no schema.
fastify.get('/users/:id', async (request) => {
  return { id: (request.params as { id: string }).id };
});

// Full config form with a body JSON Schema and a `2xx` wildcard response.
fastify.route({
  method: 'PUT',
  url: '/api/items/:id',
  schema: {
    body: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'number' },
      },
    },
    response: {
      '2xx': {
        type: 'object',
        properties: {
          updated: { type: 'string' },
        },
      },
    },
  },
  handler: async (request) => {
    return { updated: (request.params as { id: string }).id, body: request.body };
  },
});

// Full config form, no schema.
fastify.route({
  method: 'DELETE',
  url: '/api/items/:id',
  handler: async (request) => {
    return { deleted: (request.params as { id: string }).id };
  },
});

export { fastify };
