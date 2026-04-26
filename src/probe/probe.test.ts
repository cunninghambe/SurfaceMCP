import { describe, it, expect } from 'vitest';
import { recoverFromZodError } from './zod-error.js';
import { recoverFromPydanticError } from './pydantic-error.js';
import { recoverFromFastApiError } from './fastapi-error.js';
import { recoverFromDrfError } from './drf-error.js';

describe('surface_probe schema recovery', () => {
  describe('zod error recovery', () => {
    it('recovers fields from zod flattenedError', () => {
      const body = {
        error: {
          fieldErrors: {
            email: ['Invalid email'],
            password: ['String must contain at least 8 character(s)'],
            name: ['Required'],
          },
          formErrors: [],
        },
      };
      const schema = recoverFromZodError(body);
      expect(schema).toBeDefined();
      expect(schema?.properties?.email?.format).toBe('email');
      expect(schema?.properties?.password?.minLength).toBe(8);
      expect(schema?.required).toContain('email');
    });

    it('returns null for non-zod error shape', () => {
      expect(recoverFromZodError({ message: 'Not found' })).toBeNull();
    });

    it('returns null for null input', () => {
      expect(recoverFromZodError(null)).toBeNull();
    });
  });

  describe('pydantic error recovery', () => {
    it('recovers fields from Pydantic v2 detail array', () => {
      const body = {
        detail: [
          { loc: ['body', 'email'], msg: 'value is not a valid email address', type: 'value_error.email' },
          { loc: ['body', 'age'], msg: 'Input should be a valid integer', type: 'int_type' },
        ],
      };
      const schema = recoverFromPydanticError(body);
      expect(schema).toBeDefined();
      expect(schema?.properties?.email?.format).toBe('email');
      expect(schema?.required).toContain('email');
      expect(schema?.required).toContain('age');
    });

    it('returns null for non-pydantic shape', () => {
      expect(recoverFromPydanticError({ error: 'bad input' })).toBeNull();
    });
  });

  describe('FastAPI error recovery', () => {
    it('recovers fields from FastAPI validation error', () => {
      const body = {
        detail: [
          { loc: ['body', 'name'], msg: 'field required', type: 'missing' },
          { loc: ['body', 'price'], msg: 'value is not a valid float', type: 'float_type' },
        ],
      };
      const schema = recoverFromFastApiError(body);
      expect(schema).toBeDefined();
      expect(schema?.properties?.name).toBeDefined();
      expect(schema?.properties?.price?.type).toBe('number');
    });
  });

  describe('DRF error recovery', () => {
    it('recovers fields from DRF field error dict', () => {
      const body = {
        email: ['Enter a valid email address.'],
        username: ['This field is required.'],
      };
      const schema = recoverFromDrfError(body);
      expect(schema).toBeDefined();
      expect(schema?.properties?.email?.format).toBe('email');
      expect(schema?.required).toContain('username');
    });

    it('ignores non_field_errors key', () => {
      const body = {
        non_field_errors: ['Unable to log in.'],
        email: ['This field is required.'],
      };
      const schema = recoverFromDrfError(body);
      expect(schema?.properties?.non_field_errors).toBeUndefined();
    });
  });
});
