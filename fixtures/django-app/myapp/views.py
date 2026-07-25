from rest_framework.views import APIView
from rest_framework.response import Response

from .serializers import ItemSerializer


class ItemListView(APIView):
    serializer_class = ItemSerializer

    def get(self, request):
        # `many=True` marks this handler as serializing a collection, so the
        # response schema is wrapped in an array.
        return Response(ItemSerializer([], many=True).data)

    def post(self, request):
        return Response(ItemSerializer({}).data, status=201)


class ItemDetailView(APIView):
    serializer_class = ItemSerializer

    def get(self, request, pk):
        return Response(ItemSerializer({'id': pk}).data)

    def put(self, request, pk):
        return Response(ItemSerializer({'id': pk}).data)

    def delete(self, request, pk):
        # DRF destroy returns 204 with no body — no response schema is emitted.
        return Response(status=204)
