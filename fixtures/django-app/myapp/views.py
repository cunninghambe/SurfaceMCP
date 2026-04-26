from rest_framework.views import APIView
from rest_framework.response import Response


class ItemListView(APIView):
    def get(self, request):
        return Response({'items': []})

    def post(self, request):
        return Response({'item': {}}, status=201)


class ItemDetailView(APIView):
    def get(self, request, pk):
        return Response({'item': {'id': pk}})

    def put(self, request, pk):
        return Response({'item': {'id': pk}})

    def delete(self, request, pk):
        return Response({'deleted': pk})
