import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractDjangoRoutes } from './ast-walk.js';
import { buildSerializerIndex, serializerSchema } from './serializers.js';

const FIXTURES = resolve(import.meta.dirname, '../../../fixtures');
const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/** A minimal single-app Django project: root urls.py + myapp/{urls,views,serializers}.py. */
function scratchProject(files: Record<string, string>): string {
  const dir = resolve(
    tmpdir(),
    `surfacemcp-django-response-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  tmpDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const file = resolve(dir, rel);
    mkdirSync(resolve(file, '..'), { recursive: true });
    writeFileSync(file, content, 'utf-8');
  }
  return dir;
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    price: { type: 'number' },
    status: { type: 'string', enum: ['draft', 'active', 'archived'] },
    created_at: { type: 'string', format: 'date-time' },
    tags: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' } } },
    },
    owner_email: { type: 'string', format: 'email' },
  },
};

describe('django response typing — fixture', () => {
  const tools = extractDjangoRoutes(resolve(FIXTURES, 'django-app'));
  const byKey = new Map(tools.map((t) => [`${t.method} ${t.path}`, t]));

  it('maps DRF field types, formats and choices from serializer_class', () => {
    const detail = byKey.get('GET /api/items/:pk/')!;
    expect(detail.outputSchemaConfidence).toBe('inferred');
    expect(detail.outputSchema).toEqual(ITEM_SCHEMA);
  });

  it('wraps a collection handler (`many=True`) in an array', () => {
    const list = byKey.get('GET /api/items/')!;
    expect(list.outputSchemaConfidence).toBe('inferred');
    expect(list.outputSchema).toEqual({ type: 'array', items: ITEM_SCHEMA });
  });

  it('keeps the single-object shape for a create handler', () => {
    expect(byKey.get('POST /api/items/')!.outputSchema).toEqual(ITEM_SCHEMA);
  });

  it('emits nothing for DELETE (DRF destroy has no body)', () => {
    expect(byKey.get('DELETE /api/items/:pk/')!.outputSchema).toBeUndefined();
    expect(byKey.get('DELETE /api/items/:pk/')!.outputSchemaConfidence).toBeUndefined();
  });

  it('leaves route discovery, toolIds and input schemas untouched', () => {
    expect([...byKey.keys()].sort()).toEqual([
      'DELETE /api/items/:pk/',
      'GET /api/items/',
      'GET /api/items/:pk/',
      'POST /api/items/',
      'PUT /api/items/:pk/',
    ]);
    expect(byKey.get('GET /api/items/')!.inputSchemaConfidence).toBe('unknown');
    expect(byKey.get('GET /api/items/')!.inputSchema).toEqual({
      type: 'object',
      additionalProperties: true,
    });
  });
});

describe('django serializer parsing', () => {
  it('honours an explicit Meta.fields list, leaving undeclared fields open', () => {
    const index = buildSerializerIndex(`
from rest_framework import serializers


class ItemSerializer(serializers.ModelSerializer):
    name = serializers.CharField()

    class Meta:
        model = Item
        fields = ('id', 'name', 'slug')
`);
    expect(serializerSchema('ItemSerializer', index)).toEqual({
      type: 'object',
      properties: { id: {}, name: { type: 'string' }, slug: {} },
    });
  });

  it("declines fields = '__all__' (nothing statically resolvable)", () => {
    const index = buildSerializerIndex(`
from rest_framework import serializers


class ItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = Item
        fields = '__all__'
`);
    expect(serializerSchema('ItemSerializer', index)).toBeNull();
  });

  it('guards a self-referential serializer', () => {
    const index = buildSerializerIndex(`
from rest_framework import serializers


class NodeSerializer(serializers.Serializer):
    label = serializers.CharField()
    children = NodeSerializer(many=True)
`);
    const schema = serializerSchema('NodeSerializer', index)!;
    expect(schema.properties?.children).toEqual({ type: 'array', items: { type: 'object' } });
  });

  it('leaves unknown field classes open rather than guessing', () => {
    const index = buildSerializerIndex(`
from rest_framework import serializers


class ItemSerializer(serializers.Serializer):
    computed = serializers.SerializerMethodField()
    owner = serializers.PrimaryKeyRelatedField(read_only=True)
`);
    expect(serializerSchema('ItemSerializer', index)).toEqual({
      type: 'object',
      properties: { computed: {}, owner: {} },
    });
  });

  it('returns null for a serializer name it has never seen', () => {
    expect(serializerSchema('Nope', buildSerializerIndex(''))).toBeNull();
  });
});

describe('django response typing — edge cases', () => {
  it('wraps a GET on a collection path for a generic List* view', () => {
    const dir = scratchProject({
      'urls.py': `
from django.urls import path, include

urlpatterns = [
    path('api/', include('myapp.urls')),
]
`,
      'myapp/urls.py': `
from django.urls import path
from . import views

urlpatterns = [
    path('things/', views.ThingIndex.as_view(), name='thing-index'),
]
`,
      'myapp/views.py': `
from rest_framework import generics

from .serializers import ThingSerializer


class ThingIndex(generics.ListAPIView):
    serializer_class = ThingSerializer

    def get(self, request):
        return super().get(request)
`,
      'myapp/serializers.py': `
from rest_framework import serializers


class ThingSerializer(serializers.Serializer):
    label = serializers.CharField()
`,
    });
    const get = extractDjangoRoutes(dir).find((t) => t.method === 'GET')!;
    expect(get.outputSchema).toEqual({
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' } } },
    });
  });

  it('emits nothing when the view declares no serializer_class', () => {
    const dir = scratchProject({
      'urls.py': `
from django.urls import path, include

urlpatterns = [
    path('api/', include('myapp.urls')),
]
`,
      'myapp/urls.py': `
from django.urls import path
from . import views

urlpatterns = [
    path('bare/', views.BareView.as_view(), name='bare'),
]
`,
      'myapp/views.py': `
from rest_framework.views import APIView
from rest_framework.response import Response


class BareView(APIView):
    def get(self, request):
        return Response({'anything': True})
`,
      'myapp/serializers.py': `
from rest_framework import serializers


class UnusedSerializer(serializers.Serializer):
    label = serializers.CharField()
`,
    });
    for (const tool of extractDjangoRoutes(dir)) {
      expect(tool.outputSchema, `${tool.method} ${tool.path}`).toBeUndefined();
    }
  });

  it('emits nothing when there is no serializers.py at all', () => {
    const dir = scratchProject({
      'urls.py': `
from django.urls import path, include

urlpatterns = [
    path('api/', include('myapp.urls')),
]
`,
      'myapp/urls.py': `
from django.urls import path
from . import views

urlpatterns = [
    path('x/', views.XView.as_view(), name='x'),
]
`,
      'myapp/views.py': `
from rest_framework.views import APIView


class XView(APIView):
    serializer_class = MissingSerializer

    def get(self, request):
        pass
`,
    });
    for (const tool of extractDjangoRoutes(dir)) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });
});
