// Real Liquid template with a ghost code script tag from an uninstalled app.
export const liquidWithGhostScript = `
{% comment %}Installed by AppName{% endcomment %}
<script src="https://cdn.some-app.com/widget.js" data-shop="{{ shop.permanent_domain }}"></script>
`;

export const liquidWithGhostStyle = `
<link rel="stylesheet" href="https://cdn.old-app.com/styles.css" />
`;

export const liquidWithOrphanSnippet = `
{% render 'old-app-snippet' %}
`;

export const cleanLiquid = `
<h1>{{ shop.name }}</h1>
<p>Welcome to our store</p>
`;

// A template with multiple ghost code findings — useful for multi-finding detection tests.
export const liquidWithMultipleFindings = `
<script src="https://cdn.app1.com/tracker.js"></script>
<link rel="stylesheet" href="https://assets.app2.com/inject.css" />
{% render 'removed-app-widget' %}
`;
