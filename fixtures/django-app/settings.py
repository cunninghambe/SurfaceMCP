SECRET_KEY = 'fixture-secret-key'
DEBUG = True
INSTALLED_APPS = ['django.contrib.contenttypes', 'django.contrib.auth', 'rest_framework', 'myapp']
ROOT_URLCONF = 'urls'
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}
