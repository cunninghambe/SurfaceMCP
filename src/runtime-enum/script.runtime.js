(function () {
  var errors = [];
  var routers = [];
  var start = Date.now();

  function safe(name, fn) {
    try {
      var result = fn();
      if (result) routers.push(result);
    } catch (err) {
      errors.push({
        detector: name,
        message: String(err && err.message || err).slice(0, 500),
      });
    }
  }

  // ── Detector 1: TanStack Router ──────────────────────────────────────────
  safe('tanstack-router', function () {
    var r = window.__TSR_ROUTER__;
    if (!r || !r.routesByPath) return null;
    var routes = Object.keys(r.routesByPath)
      .filter(function (p) { return p !== ''; })
      .map(function (path) {
        // Order matters: convert $splat before $param (splat matches param regex too)
        var normalized = path.replace(/\$splat\b/g, '*').replace(/\$([A-Za-z_][\w]*)/g, ':$1');
        return {
          path: normalized,
          params: (normalized.match(/:[A-Za-z_][\w]*/g) || []).map(function (s) { return s.slice(1); }),
        };
      });
    return { name: 'tanstack-router', version: r.version, routes: routes };
  });

  // ── Detector 2: react-router-v6 (fiber walk) ─────────────────────────────
  safe('react-router-v6', function () {
    var roots = ['#root', '#app', '#__next', 'body > div'];
    var root = null;
    for (var i = 0; i < roots.length; i++) {
      root = document.querySelector(roots[i]);
      if (root) break;
    }
    if (!root) return null;

    var fiberKey = Object.keys(root).find(function (k) {
      return k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$');
    });
    if (!fiberKey) return null;
    var fiber = root[fiberKey];
    if (!fiber) return null;
    if (fiber.stateNode && fiber.stateNode.current) fiber = fiber.stateNode.current;

    var seen = new Set ? new Set() : [];
    var seenHas = seen.has ? function (x) { return seen.has(x); } : function (x) {
      for (var i = 0; i < seen.length; i++) if (seen[i] === x) return true;
      return false;
    };
    var seenAdd = seen.add ? function (x) { seen.add(x); } : function (x) { seen.push(x); };

    var routerState = null;
    var queue = [fiber];
    var hops = 0;

    while (queue.length && hops < 5000) {
      var node = queue.shift();
      hops++;
      if (!node || seenHas(node)) continue;
      seenAdd(node);

      var props = node.memoizedProps || node.pendingProps;
      if (props && props.router && props.router.routes) {
        routerState = props.router;
        break;
      }
      if (node.child) queue.push(node.child);
      if (node.sibling) queue.push(node.sibling);
    }

    if (!routerState) return null;

    var out = [];
    function walkRoutes(routes, prefix) {
      for (var j = 0; j < (routes || []).length; j++) {
        var r = routes[j];
        var segment = (r.path || '').replace(/^\//, '');
        var full = (prefix + (segment ? '/' + segment : '')).replace(/\/+/g, '/') || '/';
        if (r.path !== undefined && !r.index) {
          out.push({
            path: full,
            params: (full.match(/:[A-Za-z_][\w]*/g) || []).map(function (s) { return s.slice(1); }),
          });
        }
        if (r.children) walkRoutes(r.children, full);
      }
    }
    walkRoutes(routerState.routes, '');
    return { name: 'react-router-v6', routes: out };
  });

  // ── Detector 3: react-router-v5 ──────────────────────────────────────────
  safe('react-router-v5', function () {
    // v5 detection is fragile and rare in greenfield Vite apps.
    // Deferred to a future version.
    return null;
  });

  // ── Detector 4: wouter ───────────────────────────────────────────────────
  safe('wouter', function () {
    // wouter routes are in JSX — no central runtime registry.
    // Deferred to a future version.
    return null;
  });

  // ── Detector 5: vue-router ───────────────────────────────────────────────
  safe('vue-router', function () {
    var app = window.__VUE_APP__ || window.__VUE__;
    if (!app || !app.config || !app.config.globalProperties) return null;
    var router = app.config.globalProperties.$router;
    if (!router || !router.options || !router.options.routes) return null;

    var routes = [];
    function walkVueRoutes(rs, prefix) {
      for (var i = 0; i < (rs || []).length; i++) {
        var r = rs[i];
        var seg = (r.path || '').replace(/^\//, '');
        var full = (prefix + (seg ? '/' + seg : '')).replace(/\/+/g, '/') || '/';
        routes.push({
          path: full,
          params: (full.match(/:[A-Za-z_][\w]*/g) || []).map(function (s) { return s.slice(1); }),
        });
        if (r.children) walkVueRoutes(r.children, full);
      }
    }
    walkVueRoutes(router.options.routes, '');
    return { name: 'vue-router', version: router.version, routes: routes };
  });

  // ── Detector 6: next-router (current page only) ──────────────────────────
  safe('next-router', function () {
    var next = window.__NEXT_DATA__;
    if (!next || !next.page) return null;
    return { name: 'next-router', routes: [{ path: next.page, params: [] }] };
  });

  return { routers: routers, errors: errors, elapsedMs: Date.now() - start };
})()
