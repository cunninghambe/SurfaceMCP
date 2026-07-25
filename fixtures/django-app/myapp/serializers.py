from rest_framework import serializers


class TagSerializer(serializers.Serializer):
    label = serializers.CharField()


class ItemSerializer(serializers.Serializer):
    id = serializers.IntegerField()
    name = serializers.CharField(max_length=200)
    price = serializers.DecimalField(max_digits=8, decimal_places=2)
    status = serializers.ChoiceField(choices=['draft', 'active', 'archived'])
    created_at = serializers.DateTimeField(read_only=True)
    tags = TagSerializer(many=True)
    owner_email = serializers.EmailField(required=False)
