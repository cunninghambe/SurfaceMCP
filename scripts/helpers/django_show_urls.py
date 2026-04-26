#!/usr/bin/env python3
"""
Optional Django URL extraction helper.
Used as fallback when django-extensions is not installed.

Usage: python3 django_show_urls.py <settings_module>
"""
import sys
import json
import os


def main():
    if len(sys.argv) < 2:
        print("Usage: django_show_urls.py <django_settings_module>", file=sys.stderr)
        sys.exit(1)

    settings_module = sys.argv[1]
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", settings_module)

    try:
        import django
        django.setup()
        from django.urls import get_resolver
    except Exception as e:
        print(f"Error loading Django: {e}", file=sys.stderr)
        sys.exit(1)

    resolver = get_resolver()
    routes = []

    def collect_urls(resolver, prefix=""):
        from django.urls import URLPattern, URLResolver
        for pattern in resolver.url_patterns:
            if isinstance(pattern, URLResolver):
                collect_urls(pattern, prefix + str(pattern.pattern))
            elif isinstance(pattern, URLPattern):
                url = prefix + str(pattern.pattern)
                routes.append({
                    "url": "/" + url.lstrip("/"),
                    "name": pattern.name or "",
                    "module": getattr(pattern.callback, "__module__", ""),
                })

    collect_urls(resolver)
    print(json.dumps(routes, indent=2))


if __name__ == "__main__":
    main()
