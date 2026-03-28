/**
 * Static database of known Shopify app signatures.
 *
 * Each entry maps a human-readable app name to the set of signals we
 * look for when scanning theme files:
 *   - cdnDomains  : External script / stylesheet origins
 *   - scriptPatterns : RegExp patterns for script src or inline JS identifiers
 *   - snippetNames   : Liquid snippet/section names the app injects
 *   - cssPatterns    : RegExp patterns that appear inside CSS `<link>` hrefs or
 *                      inline `<style>` blocks
 *
 * KEEP IN SYNC with app-lookup.server.ts — any new fields added here need a
 * corresponding lookup function there.
 *
 * NOTE: Do NOT add the /g flag to regex patterns. They are used with .test()
 * in app-lookup.server.ts, and /g causes stateful lastIndex behavior that
 * leads to intermittent match failures on repeated .test() calls.
 */

export type AppSignature = {
  appName: string;
  cdnDomains: string[];
  scriptPatterns: RegExp[];
  snippetNames: string[];
  cssPatterns: RegExp[];
  hrefLangPatterns?: RegExp[];
  jsonLdPatterns?: RegExp[];
  textPatterns?: RegExp[];
  isTracker?: boolean;
};

export const APP_SIGNATURES: AppSignature[] = [
  // -------------------------------------------------------------------------
  // Analytics & Marketing
  // -------------------------------------------------------------------------
  {
    appName: "Klaviyo",
    cdnDomains: ["static.klaviyo.com", "cdn.klaviyo.com", "a.klaviyo.com"],
    scriptPatterns: [/klaviyo\.js/, /klaviyo-onsite/, /KlaviyoSubscribe/, /_klOnsite/],
    snippetNames: ["klaviyo-onsite", "klaviyo-form", "klaviyo-tracking", "klaviyo-bis-form"],
    cssPatterns: [/klaviyo/],
  },
  {
    appName: "Omnisend",
    cdnDomains: ["cdn.omnisend.com", "app.omnisend.com"],
    scriptPatterns: [/omnisend\.js/, /omnisendBeacon/, /window\.omnisend/],
    snippetNames: ["omnisend-newsletter", "omnisend-snippet"],
    cssPatterns: [/omnisend/],
  },
  {
    appName: "Privy",
    cdnDomains: ["widget.privy.com", "cdn.privy.com"],
    scriptPatterns: [/privy\.js/, /PrivyFactory/, /window\.Privy/],
    snippetNames: ["privy-widget", "privy-snippet"],
    cssPatterns: [/privy/],
  },
  {
    appName: "Mailchimp",
    cdnDomains: [
      "chimpstatic.com",
      "cdn-images.mailchimp.com",
      "s3.amazonaws.com/downloads.mailchimp.com",
    ],
    scriptPatterns: [/mailchimp\.js/, /mc\.js/, /chimpstatic\.com/],
    snippetNames: ["mailchimp-popup", "mailchimp-form"],
    cssPatterns: [/mailchimp/, /chimpstatic/],
  },
  {
    appName: "Google Analytics (UA)",
    cdnDomains: ["www.google-analytics.com", "ssl.google-analytics.com"],
    scriptPatterns: [/ga\.js/, /analytics\.js/, /UA-\d{4,}/, /GoogleAnalyticsObject/],
    snippetNames: ["google-analytics", "ga-tracking"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Google Tag Manager",
    cdnDomains: ["www.googletagmanager.com"],
    scriptPatterns: [/gtm\.js/, /GTM-[A-Z0-9]+/, /googletagmanager\.com/],
    snippetNames: ["google-tag-manager", "gtm-snippet"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Hotjar",
    cdnDomains: ["static.hotjar.com", "script.hotjar.com", "vars.hotjar.com"],
    scriptPatterns: [/hotjar\.js/, /hjid[=:]/, /window\.hj\s*=/, /hotjar-\d+/, /h\.hjid/],
    snippetNames: ["hotjar-tracking", "hotjar-snippet"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Lucky Orange",
    cdnDomains: ["d10lpsik1i8c69.cloudfront.net", "cdn.luckyorange.com"],
    scriptPatterns: [/luckyorange\.com/, /window\.__lo_site_id/],
    snippetNames: ["lucky-orange"],
    cssPatterns: [/luckyorange/],
    isTracker: true,
  },
  {
    appName: "Microsoft Clarity",
    cdnDomains: ["clarity.ms", "www.clarity.ms"],
    scriptPatterns: [/clarity\.ms/, /window\.clarity\b/, /clarity\("set"/],
    snippetNames: ["microsoft-clarity", "clarity"],
    cssPatterns: [],
    isTracker: true,
  },

  // -------------------------------------------------------------------------
  // Analytics & Tracking
  // -------------------------------------------------------------------------
  {
    appName: "Elevar",
    cdnDomains: ["getelevar.com"],
    scriptPatterns: [/getelevar\.com/, /window\.ElevarDataLayer/, /ElevarInvalidateContext/],
    snippetNames: [
      "elevar-head",
      "elevar-head-listener",
      "elevar-body-end",
      "elevar-checkout-end",
      "elevar-checkout-additional-scripts",
    ],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Triple Whale",
    cdnDomains: ["api.triplewhale.com", "cdn.triplewhale.com"],
    scriptPatterns: [/triplewhale\.com/, /TriplePixel/, /TriplePixelData/, /window\.TriplePixel\b/],
    snippetNames: ["triple-whale-pixel", "triple-whale"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Littledata",
    cdnDomains: ["cdn.littledata.io", "app.littledata.io"],
    scriptPatterns: [/littledata\.io/, /LittledataLayer/, /window\.LittledataLayer\b/],
    snippetNames: ["LittledataLayer"],
    cssPatterns: [],
    isTracker: true,
  },

  // -------------------------------------------------------------------------
  // Reviews
  // -------------------------------------------------------------------------
  {
    appName: "Judge.me",
    cdnDomains: ["cdn.judge.me", "judge.me"],
    scriptPatterns: [/judge\.me/, /jdgm\b/, /JudgeMe/],
    snippetNames: ["judgeme_widgets", "jdgm-widget", "jdgm-review", "jdgm_widgets"],
    cssPatterns: [/jdgm/, /judge\.me/],
    jsonLdPatterns: [/judge\.me/i, /jdgm/i],
    textPatterns: [/\bjdgm-widget\b/, /\bjdgm-review-widget\b/, /\bdata-jdgm-widget\b/],
  },
  {
    appName: "Loox",
    cdnDomains: ["cdn.loox.io", "loox.io"],
    scriptPatterns: [/loox\.io/, /window\.loox/],
    snippetNames: ["loox-init", "loox-reviews", "loox_reviews"],
    cssPatterns: [/loox/],
    jsonLdPatterns: [/loox\.io/i, /loox/i],
    textPatterns: [/\bloox-reviews-default\b/, /\bdata-loox-product-id\b/],
  },
  {
    appName: "Stamped.io",
    cdnDomains: ["cdn1.stamped.io", "cdn2.stamped.io", "stamped.io"],
    scriptPatterns: [/stamped\.io/, /StampedFn/, /window\.StampedSDK/],
    snippetNames: ["stamped-main-widget", "stamped-reviews-widget"],
    cssPatterns: [/stamped/],
    jsonLdPatterns: [/stamped\.io/i, /stamped/i],
    textPatterns: [
      /\bstamped-reviews-widget\b/,
      /\bdata-stamped-product\b/,
      /\bstamped-main-widget\b/,
    ],
  },
  {
    appName: "Yotpo",
    cdnDomains: ["staticw2.yotpo.com", "cdn2.yotpo.com"],
    scriptPatterns: [/yotpo\.js/, /YotpoWidgetsMap/, /window\.yotpo/, /yotpoWidget/],
    snippetNames: ["yotpo-bottomline", "yotpo-reviews", "yotpo_reviews"],
    cssPatterns: [/yotpo/],
    jsonLdPatterns: [/yotpo\.com/i, /yotpo/i],
    textPatterns: [
      /\byotpo-widget-instance\b/,
      /\bdata-yotpo-product-id\b/,
      /\byotpo-bottomline\b/,
    ],
  },
  {
    appName: "Air Reviews",
    cdnDomains: ["cdn.airreviews.io"],
    scriptPatterns: [/airreviews\.io/, /AirReviews/],
    snippetNames: ["air-reviews", "air-reviews-widget"],
    cssPatterns: [/airreviews/, /air-reviews/],
    jsonLdPatterns: [/airreviews\.io/i, /air-reviews/i],
    textPatterns: [/\bdata-air-review\b/],
  },
  {
    appName: "Okendo",
    cdnDomains: ["cdn.okendo.io", "d3hw6dc1ow8pp2.cloudfront.net"],
    scriptPatterns: [/okendo\.io/, /OkendoReviews/, /window\.okendo\b/],
    snippetNames: ["okendo-reviews", "okendo-widget"],
    cssPatterns: [/okendo/],
    jsonLdPatterns: [/okendo\.io/i, /okendo/i],
    textPatterns: [/\bokendo-reviews-widget\b/, /\bdata-oke-widget\b/],
  },
  {
    appName: "Fera Reviews",
    cdnDomains: ["cdn.fera.ai", "app-cdn.fera.ai", "app.fera.ai"],
    scriptPatterns: [/fera\.ai/, /window\.fera\b/, /feraAppId/],
    snippetNames: ["fera-reviews", "fera-widget"],
    cssPatterns: [/fera/],
    jsonLdPatterns: [/fera\.ai/i],
  },
  {
    appName: "Shopify Product Reviews",
    cdnDomains: [],
    scriptPatterns: [/product-reviews\.shopify/, /SPR\.init/],
    snippetNames: ["product-reviews", "spr-stars"],
    cssPatterns: [/spr-container/, /spr-form/],
    jsonLdPatterns: [/spr/i, /product-reviews/i],
    textPatterns: [/\bspr-container\b/, /\bspr-badge\b/],
  },

  // -------------------------------------------------------------------------
  // Chat & Support
  // -------------------------------------------------------------------------
  {
    appName: "Gorgias",
    cdnDomains: ["config.gorgias.chat", "client-builds.gorgias.chat"],
    scriptPatterns: [/gorgias\.chat/, /window\.GorgiasChat/, /gorgias-web-messenger/],
    snippetNames: ["gorgias-chat", "gorgias-snippet"],
    cssPatterns: [/gorgias/],
  },
  {
    appName: "Tidio",
    cdnDomains: ["code.tidio.co"],
    scriptPatterns: [/tidio\.co/, /tidioChatCode/, /window\.tidioChatApi/],
    snippetNames: ["tidio-chat"],
    cssPatterns: [],
  },
  {
    appName: "Zendesk",
    cdnDomains: ["static.zdassets.com", "ekr.zdassets.com"],
    scriptPatterns: [/zdassets\.com/, /ze\('webWidget'/, /ZendeskWidget/],
    snippetNames: ["zendesk-widget", "zopim"],
    cssPatterns: [/zdassets/],
  },
  {
    appName: "Intercom",
    cdnDomains: ["js.intercomcdn.com", "widget.intercom.io"],
    scriptPatterns: [/intercomcdn\.com/, /window\.Intercom\b/, /intercom\.io\/widget/],
    snippetNames: ["intercom-snippet"],
    cssPatterns: [],
  },
  {
    appName: "Drift",
    cdnDomains: ["js.driftt.com", "cdn.driftt.com"],
    scriptPatterns: [/driftt\.com/, /window\.drift\b/, /drift\.load/],
    snippetNames: ["drift-widget"],
    cssPatterns: [],
  },
  {
    appName: "tawk.to",
    cdnDomains: ["embed.tawk.to"],
    scriptPatterns: [/tawk\.to/, /Tawk_API/, /window\.Tawk_API/],
    snippetNames: ["tawk-to", "tawk-chat"],
    cssPatterns: [/tawk/],
  },

  // -------------------------------------------------------------------------
  // Loyalty
  // -------------------------------------------------------------------------
  {
    appName: "Rivo Loyalty",
    cdnDomains: ["cdn.rivo.io", "app.rivo.io"],
    scriptPatterns: [/rivo\.io/, /window\.rivo\b/, /RivoJS/],
    snippetNames: ["rivo-loyalty", "rivo-widget"],
    cssPatterns: [/rivo/],
  },
  {
    appName: "Smile.io",
    cdnDomains: ["cdn.smile.io", "d2v9k67syz0xku.cloudfront.net"],
    scriptPatterns: [/smile\.io/, /sweetTooth/, /window\.SwellAPI/],
    snippetNames: ["smile-initializer", "smile-ui", "loyalty-lion-initializer"],
    cssPatterns: [/smile-launcher/],
  },
  {
    appName: "LoyaltyLion",
    cdnDomains: ["sdk.loyaltylion.net", "loyaltylion.net"],
    scriptPatterns: [/loyaltylion\.net/, /window\.lion\b/, /LoyaltyLion/],
    snippetNames: ["loyalty-lion-initializer", "loyalty-lion-footer"],
    cssPatterns: [/loyaltylion/],
  },
  {
    appName: "Rise.ai",
    cdnDomains: ["cdn.rise.ai", "api.rise.ai"],
    scriptPatterns: [/rise\.ai/, /Rise\.init/],
    snippetNames: ["rise-gift-card", "rise-ai-wallet"],
    cssPatterns: [/rise-ai/],
  },

  // -------------------------------------------------------------------------
  // Upsell & Cross-sell
  // -------------------------------------------------------------------------
  {
    appName: "Rebuy",
    cdnDomains: ["cdn.rebuyengine.com"],
    scriptPatterns: [/rebuyengine\.com/, /rebuy\.js/, /window\.Rebuy\b/],
    snippetNames: ["rebuy-templates", "rebuy-cart-template", "rebuy-widget"],
    cssPatterns: [/rebuy/],
  },
  {
    appName: "Frequently Bought Together",
    cdnDomains: ["codeblackbelt.com", "web.codeblackbelt.com"],
    scriptPatterns: [/codeblackbelt\.com/, /frequentlyBoughtTogether/, /CBBFbt/],
    snippetNames: ["cbb-frequently-bought-together", "frequently-bought-together"],
    cssPatterns: [/cbb-fbt/, /codeblackbelt/],
  },
  {
    appName: "Candy Rack",
    cdnDomains: ["cdn.digismoothie.com"],
    scriptPatterns: [/digismoothie\.com/, /candyrack/i, /CandyRack/],
    snippetNames: ["candy-rack", "candyrack"],
    cssPatterns: [/candyrack/, /candy-rack/],
  },
  {
    appName: "Wiser AI Recommendations",
    cdnDomains: ["cdn.getwiser.ai", "getwiser.ai"],
    scriptPatterns: [/getwiser\.ai/, /wiser-widget/],
    snippetNames: ["wiser-widget", "wiser-recommendations"],
    cssPatterns: [/wiser/, /getwiser/],
  },
  {
    appName: "Selleasy",
    cdnDomains: ["cdn.logbase.io", "logbase.io"],
    scriptPatterns: [/logbase\.io/, /selleasy/i],
    snippetNames: ["selleasy", "selleasy-widget"],
    cssPatterns: [/selleasy/],
  },
  {
    appName: "Bold Commerce",
    cdnDomains: ["cdn.boldapps.net", "boldapps.net"],
    scriptPatterns: [/boldapps\.net/, /BOLD\.common/, /BoldCommerce/],
    snippetNames: ["bold-variant-option", "bold-product-builder", "bold-common"],
    cssPatterns: [/boldapps/],
  },
  {
    appName: "ReConvert",
    cdnDomains: ["cdn.reconvert.io", "reconvert.io"],
    scriptPatterns: [/reconvert\.io/, /ReConvert/],
    snippetNames: ["reconvert-upsell"],
    cssPatterns: [/reconvert/],
  },
  {
    appName: "Zipify OneClickUpsell",
    cdnDomains: ["cdn.zipify.com", "zipify.com"],
    scriptPatterns: [/zipify\.com/, /ZipifyOCU/, /window\.zipify/],
    snippetNames: ["zipify-ocu"],
    cssPatterns: [/zipify/],
  },
  {
    appName: "CartHook",
    cdnDomains: ["cdn.carthook.com", "carthook.com"],
    scriptPatterns: [/carthook\.com/, /CartHook/],
    snippetNames: ["carthook-post-purchase"],
    cssPatterns: [/carthook/],
  },

  // -------------------------------------------------------------------------
  // Social & Pixels
  // -------------------------------------------------------------------------
  {
    appName: "Pinterest Pixel",
    cdnDomains: ["s.pinimg.com", "ct.pinterest.com"],
    scriptPatterns: [/s\.pinimg\.com/, /pintrk\(/, /ct\.pinterest\.com/, /PinterestTag/],
    snippetNames: ["pinterest-pixel", "pinterest-tag"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Snapchat Pixel",
    cdnDomains: ["sc-static.net", "tr.snapchat.com"],
    scriptPatterns: [/sc-static\.net/, /snaptr\(/, /tr\.snapchat\.com/, /scevent\.min\.js/],
    snippetNames: ["snapchat-pixel", "snap-pixel"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Facebook Pixel (legacy)",
    cdnDomains: ["connect.facebook.net"],
    scriptPatterns: [/connect\.facebook\.net/, /fbq\('init'/, /fbevents\.js/],
    snippetNames: ["facebook-pixel", "fb-pixel"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "TikTok Pixel",
    cdnDomains: ["analytics.tiktok.com"],
    scriptPatterns: [/analytics\.tiktok\.com/, /ttq\.load/, /TiktokAnalyticsObject/],
    snippetNames: ["tiktok-pixel", "tiktok-snippet"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Instagram Feed",
    cdnDomains: ["cdn.lightwidget.com", "instagram.com"],
    scriptPatterns: [/lightwidget\.com/, /instagramFeed/, /window\.instgrm/],
    snippetNames: ["instagram-feed", "instafeed"],
    cssPatterns: [/instagram-feed/, /instafeed/],
  },

  // -------------------------------------------------------------------------
  // Search & Filter
  // -------------------------------------------------------------------------
  {
    appName: "Boost AI Search",
    cdnDomains: ["services.mybcapps.com"],
    scriptPatterns: [
      /boostcommerce\.net/,
      /boost-pfs/,
      /boost-sd/,
      /bc-sf-filter/,
      /window\.boostSDTaeUtils/,
    ],
    snippetNames: ["boost-pfs", "boost-pfs-filter-html", "boost-sd-app", "bc-sf-filter"],
    cssPatterns: [/boost-pfs/, /boost-sd/, /bc-sf-filter/],
  },
  {
    appName: "Searchanise",
    cdnDomains: ["searchserverapi.com", "searchanise.com"],
    scriptPatterns: [
      /searchserverapi\.com/,
      /searchanise\.com/,
      /Searchanise/,
      /SearchaniseSearchResults/,
    ],
    snippetNames: ["searchanise", "searchanise-search-results"],
    cssPatterns: [/searchanise/],
  },

  // -------------------------------------------------------------------------
  // SEO
  // -------------------------------------------------------------------------
  {
    appName: "Avada SEO Suite",
    cdnDomains: ["cdn.avada.io"],
    scriptPatterns: [/avada\.io/, /AvadaSEO/, /avada-seo/],
    snippetNames: ["avada-seo", "avada-seo-suite"],
    cssPatterns: [/avada/],
    jsonLdPatterns: [/avada\.io/i, /avada/i],
  },
  {
    appName: "BOOSTER SEO",
    cdnDomains: ["cdn.boosterapps.com"],
    scriptPatterns: [/boosterapps\.com/, /BoosterSEO/, /booster-seo/],
    snippetNames: ["booster-seo", "booster-apps-seo"],
    cssPatterns: [/boosterapps/, /booster-seo/],
  },
  {
    appName: "SEO Manager",
    cdnDomains: [],
    scriptPatterns: [/SEOManager/, /seo-manager/],
    snippetNames: ["seo-manager", "searchpie"],
    cssPatterns: [],
  },
  {
    appName: "Plug in SEO",
    cdnDomains: ["cdn.pluginseo.com"],
    scriptPatterns: [/pluginseo\.com/, /PlugInSEO/],
    snippetNames: ["plugin-seo", "plug-in-seo"],
    cssPatterns: [/pluginseo/],
  },
  {
    appName: "JSON-LD for SEO",
    cdnDomains: [],
    scriptPatterns: [/json-ld-for-seo/, /jsonld.*shopify/i],
    snippetNames: ["json-ld-for-seo", "schema-for-seo"],
    cssPatterns: [],
    jsonLdPatterns: [/json-ld-for-seo/i],
  },

  // -------------------------------------------------------------------------
  // Shipping
  // -------------------------------------------------------------------------
  {
    appName: "AfterShip",
    cdnDomains: ["cdn.aftership.com", "assets.aftership.com"],
    scriptPatterns: [/aftership\.com/, /AfterShip\.init/],
    snippetNames: ["aftership-tracking", "aftership"],
    cssPatterns: [/aftership/],
  },
  {
    appName: "ShipStation",
    cdnDomains: [],
    scriptPatterns: [/shipstation\.com/, /ShipStation/],
    snippetNames: ["shipstation"],
    cssPatterns: [],
  },
  {
    appName: "Shippo",
    cdnDomains: ["cdn.goshippo.com"],
    scriptPatterns: [/goshippo\.com/, /Shippo\.init/],
    snippetNames: ["shippo"],
    cssPatterns: [],
  },

  // -------------------------------------------------------------------------
  // Pop-ups
  // -------------------------------------------------------------------------
  {
    appName: "Sumo / BDOW!",
    cdnDomains: ["load.sumo.com", "load.sumome.com"],
    scriptPatterns: [/load\.sumo\.com/, /load\.sumome\.com/, /sumo-site-id/, /window\.sumo\b/],
    snippetNames: ["sumo", "sumome"],
    cssPatterns: [/sumo/],
  },
  {
    appName: "Pop Convert",
    cdnDomains: ["cdn.popconvert.com"],
    scriptPatterns: [/popconvert\.com/, /PopConvert/],
    snippetNames: ["popconvert", "pop-convert"],
    cssPatterns: [/popconvert/],
  },
  {
    appName: "EcomSend",
    cdnDomains: ["cdn.ecomsend.com"],
    scriptPatterns: [/ecomsend\.com/, /EcomSend/],
    snippetNames: ["ecomsend", "ecomsend-popup"],
    cssPatterns: [/ecomsend/],
  },
  {
    appName: "Justuno",
    cdnDomains: ["cdn.justuno.com", "app.justuno.com"],
    scriptPatterns: [/justuno\.com/, /window\.ju_num/],
    snippetNames: ["justuno"],
    cssPatterns: [/justuno/],
  },
  {
    appName: "OptiMonk",
    cdnDomains: ["cdn.optimonk.com"],
    scriptPatterns: [/optimonk\.com/, /OptiMonk/],
    snippetNames: ["optimonk", "optimonk-snippet"],
    cssPatterns: [/optimonk/],
  },
  {
    appName: "Wisepops",
    cdnDomains: ["wisepops.com", "cdn.wisepops.com"],
    scriptPatterns: [/wisepops\.com/, /window\.wisepops/],
    snippetNames: ["wisepops"],
    cssPatterns: [/wisepops/],
  },

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------
  {
    appName: "Recharge",
    cdnDomains: ["cdn.rechargeapps.com", "rechargepayments.com"],
    scriptPatterns: [/rechargeapps\.com/, /ReCharge\.init/, /window\.ReCharge/],
    snippetNames: ["recharge-checkout-option", "rc_subscription_widget", "recharge"],
    cssPatterns: [/recharge/],
  },

  // -------------------------------------------------------------------------
  // Page Builders
  // -------------------------------------------------------------------------
  {
    appName: "PageFly",
    cdnDomains: ["ik.imagekit.io/pagefly", "cdn.pagefly.io"],
    scriptPatterns: [/pagefly/i, /PageFly/],
    snippetNames: [
      "pagefly-head",
      "pagefly-body-end",
      "pagefly",
      "pagefly-main-js",
      "pf-style",
      "pf-head",
      "pf-body",
      "pf-footer",
    ],
    cssPatterns: [/pagefly/i],
  },
  {
    appName: "Shogun",
    cdnDomains: ["cdn.getshogun.com", "getshogun.com"],
    scriptPatterns: [/getshogun\.com/, /window\.ShogunFrontend/, /shogun-root/],
    snippetNames: ["shogun-head", "shogun-scripts", "shogun"],
    cssPatterns: [/getshogun/, /shogun-/],
  },
  {
    appName: "GemPages",
    cdnDomains: ["cdn.ampify.com", "cdn.gempages.net"],
    scriptPatterns: [/gempages\.net/, /GemPages/],
    snippetNames: ["gem-app-header-scripts", "gem-app-footer-scripts", "gempages"],
    cssPatterns: [/gempages/],
  },
  {
    appName: "EComposer",
    cdnDomains: ["cdn.ecomposer.io", "ecomposer.io"],
    scriptPatterns: [/ecomposer\.io/, /EComposer/],
    snippetNames: ["ecomposer", "ecomposer-head", "ecomposer-body"],
    cssPatterns: [/ecomposer/],
  },

  // -------------------------------------------------------------------------
  // Wishlist & Social Proof
  // -------------------------------------------------------------------------
  {
    appName: "Growave",
    cdnDomains: ["cdn.growave.io"],
    scriptPatterns: [/growave\.io/, /Growave/, /window\.growave\b/],
    snippetNames: ["growave-init", "growave-widget"],
    cssPatterns: [/growave/],
    jsonLdPatterns: [/growave\.io/i, /growave/i],
  },
  {
    appName: "Wishlist Plus (Swym)",
    cdnDomains: ["cdn.swymrelay.com", "swymrelay.com", "swym.it"],
    scriptPatterns: [/swymrelay\.com/, /swym\.it/, /SwymCallbacks/, /window\.swym\b/],
    snippetNames: ["swym-wishlist", "wishlist-plus"],
    cssPatterns: [/swym/],
    textPatterns: [/\bswym-wishlist\b/, /\bdata-swym-collection\b/, /\bswym-button\b/],
  },
  {
    appName: "FOMO",
    cdnDomains: ["cdn.fomo.com", "app.fomo.com"],
    scriptPatterns: [/fomo\.com\/js/, /Fomo\.init/, /window\.fomo\b/],
    snippetNames: ["fomo-notification"],
    cssPatterns: [/fomo/],
  },
  {
    appName: "Sales Pop / Hextom",
    cdnDomains: ["cdn.hextom.com"],
    scriptPatterns: [/hextom\.com/, /window\.hextom\b/],
    snippetNames: ["hextom-shipping-bar", "hextom-sales-pop"],
    cssPatterns: [/hextom/],
    textPatterns: [/\bhextom_(?:qab|fsb|ctb)_\w+\b/, /\bhextom-[a-z]+-bar\b/],
  },

  // -------------------------------------------------------------------------
  // Currency & Translation
  // -------------------------------------------------------------------------
  {
    appName: "Weglot",
    cdnDomains: ["cdn.weglot.com"],
    scriptPatterns: [/weglot\.com/, /Weglot\.initialize/, /window\.Weglot\b/],
    snippetNames: ["weglot-switcher"],
    cssPatterns: [/weglot/],
    hrefLangPatterns: [/weglot\.com/, /^https?:\/\/[a-z]{2}\./],
  },
  {
    appName: "Transcy",
    cdnDomains: ["cdn.transcy.io"],
    scriptPatterns: [/transcy\.io/, /Transcy/, /window\.transcy\b/],
    snippetNames: ["transcy", "transcy-switcher"],
    cssPatterns: [/transcy/],
    hrefLangPatterns: [/transcy\.io/],
  },
  {
    appName: "Langify",
    cdnDomains: ["cdn.langify-app.com"],
    scriptPatterns: [/langify-app\.com/, /langify/, /window\.langify\b/],
    snippetNames: ["langify", "langify-switcher"],
    cssPatterns: [/langify/],
    hrefLangPatterns: [/langify-app\.com/, /\/a\/l\//],
  },
  {
    appName: "LangShop",
    cdnDomains: ["cdn.langshop.app"],
    scriptPatterns: [/langshop\.app/, /LangShop/, /window\.langshop\b/],
    snippetNames: ["langshop", "langshop-switcher"],
    cssPatterns: [/langshop/],
    hrefLangPatterns: [/langshop\.app/],
  },
  {
    appName: "Hextom Translate",
    cdnDomains: [],
    scriptPatterns: [/hextom\.com\/.*translate/, /HextomTranslate/],
    snippetNames: ["hextom-translate", "hextom-translate-switcher"],
    cssPatterns: [/hextom.*translate/],
    hrefLangPatterns: [/hextom\.com/],
  },
  // Translate & Adapt uses Shopify's built-in locale paths — keep AFTER
  // domain-specific translation apps so their patterns take priority.
  {
    appName: "Translate & Adapt",
    cdnDomains: [],
    scriptPatterns: [/shopify-translate-adapt/],
    snippetNames: ["translate-adapt"],
    cssPatterns: [],
    hrefLangPatterns: [
      /\/(?:fr|de|es|it|pt|ja|ko|zh|nl|ru|ar|pl|sv|da|no|fi|cs|el|tr|th|vi|id|ms|hi|bn|uk|ro|hu|bg|hr|sk|sl|lt|lv|et|sr)(?:\/|$)/,
    ],
  },
  {
    appName: "Currency Converter (BEST)",
    cdnDomains: ["cdn.currencyconverterwidget.com"],
    scriptPatterns: [/currencyconverterwidget\.com/, /currencyconverterwidget/],
    snippetNames: ["currency-converter"],
    cssPatterns: [/currencyconverterwidget/],
  },

  // -------------------------------------------------------------------------
  // Accessibility
  // -------------------------------------------------------------------------
  {
    appName: "accessiBe",
    cdnDomains: ["acsbapp.com", "acsbap.com"],
    scriptPatterns: [/acsbapp\.com/, /acsbap\.com/, /acsb\.js/],
    snippetNames: ["accessibe"],
    cssPatterns: [/acsbapp/, /accessiBe/i],
  },

  // -------------------------------------------------------------------------
  // Cookie Consent
  // -------------------------------------------------------------------------
  {
    appName: "Pandectes GDPR",
    cdnDomains: ["cdn.pandectes.io"],
    scriptPatterns: [/pandectes\.io/, /Pandectes/, /pandectes-consent/],
    snippetNames: ["pandectes-cookie", "pandectes-consent"],
    cssPatterns: [/pandectes/],
  },
  {
    appName: "CookieYes",
    cdnDomains: ["cdn-cookieyes.com"],
    scriptPatterns: [/cdn-cookieyes\.com/, /cookieyes/, /CookieYes/],
    snippetNames: ["cookieyes", "cookie-consent"],
    cssPatterns: [/cookieyes/],
  },
  {
    appName: "Cookiebot",
    cdnDomains: ["consent.cookiebot.com", "consentcdn.cookiebot.com"],
    scriptPatterns: [/consent\.cookiebot\.com/, /Cookiebot/, /CookiebotOnConsentReady/],
    snippetNames: ["cookiebot"],
    cssPatterns: [/cookiebot/],
  },
  {
    appName: "iubenda",
    cdnDomains: ["cdn.iubenda.com"],
    scriptPatterns: [/cdn\.iubenda\.com/, /iubenda_cs\.js/, /window\._iub\b/],
    snippetNames: ["iubenda", "iubenda-cookie"],
    cssPatterns: [/iubenda/],
  },
  {
    appName: "Consentmo",
    cdnDomains: ["cdn.consentmo.com"],
    scriptPatterns: [/consentmo/i, /consentmoGDPR/, /consentmo-gcm-blocking/],
    snippetNames: ["gcm-integration-script", "consentmo-cookie"],
    cssPatterns: [/consentmo/],
  },

  // -------------------------------------------------------------------------
  // Size & Fit
  // -------------------------------------------------------------------------
  {
    appName: "Kiwi Size Chart",
    cdnDomains: ["cdn.kiwisizing.com"],
    scriptPatterns: [/kiwisizing\.com/, /KiwiSizing/],
    snippetNames: ["kiwi-size-chart"],
    cssPatterns: [/kiwisizing/],
    textPatterns: [/\bkiwi-sizing-chart\b/, /\bdata-kiwi-size-chart\b/],
  },

  // -------------------------------------------------------------------------
  // Returns
  // -------------------------------------------------------------------------
  {
    appName: "Loop Returns",
    cdnDomains: ["cdn.loopreturns.com"],
    scriptPatterns: [/loopreturns\.com/, /LoopReturns/],
    snippetNames: ["loop-returns"],
    cssPatterns: [/loopreturns/],
  },
  {
    appName: "Narvar",
    cdnDomains: ["cdn.narvar.com"],
    scriptPatterns: [/narvar\.com/, /NarvarWidget/],
    snippetNames: ["narvar-tracking"],
    cssPatterns: [/narvar/],
  },

  // -------------------------------------------------------------------------
  // Product Bundling
  // -------------------------------------------------------------------------
  {
    appName: "Vitals",
    cdnDomains: ["cdn.vitals.co"],
    scriptPatterns: [/vitals\.co/, /VitalsApp/, /window\.vitals\b/],
    snippetNames: ["vitals-head", "vitals-body"],
    cssPatterns: [/vitals/],
  },

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------
  {
    appName: "Back in Stock (Appikon)",
    cdnDomains: ["cdn.appikon.com"],
    scriptPatterns: [/appikon\.com/, /BackInStock/, /window\.BackInStock\b/],
    snippetNames: ["back-in-stock", "bis-notification"],
    cssPatterns: [/appikon/, /back-in-stock/],
  },

  // -------------------------------------------------------------------------
  // Age Verification
  // -------------------------------------------------------------------------
  {
    appName: "Ageify / Age Verification",
    cdnDomains: ["cdn.ageify.com"],
    scriptPatterns: [/ageify\.com/, /AgeVerification/, /window\.ageify\b/],
    snippetNames: ["ageify", "age-verification"],
    cssPatterns: [/ageify/, /age-verification/],
  },

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------
  {
    appName: "PushOwl",
    cdnDomains: ["cdn.pushowl.com"],
    scriptPatterns: [/pushowl\.com/, /PushOwl/],
    snippetNames: ["pushowl"],
    cssPatterns: [],
  },
  {
    appName: "Recart",
    cdnDomains: ["cdn.recart.com"],
    scriptPatterns: [/recart\.com/, /RecartSDK/],
    snippetNames: ["recart"],
    cssPatterns: [],
  },
  {
    appName: "Trustpilot",
    cdnDomains: ["widget.trustpilot.com", "invitejs.trustpilot.com"],
    scriptPatterns: [/trustpilot\.com/, /window\.Trustpilot/],
    snippetNames: ["trustpilot-widget", "trustpilot"],
    cssPatterns: [/trustpilot/],
    jsonLdPatterns: [/trustpilot\.com/i, /trustpilot/i],
  },
  {
    appName: "Wheelio / Spin-to-Win",
    cdnDomains: ["cdn.wheelio-app.com"],
    scriptPatterns: [/wheelio-app\.com/, /window\.wheelioSettings/],
    snippetNames: ["wheelio", "spin-to-win"],
    cssPatterns: [/wheelio/],
  },
  {
    appName: "Searchie / SearchPie",
    cdnDomains: ["cdn.searchpie.io"],
    scriptPatterns: [/searchpie\.io/, /SearchPie/],
    snippetNames: ["searchpie", "searchpie-seo"],
    cssPatterns: [/searchpie/],
  },
  {
    appName: "Socialhead",
    cdnDomains: ["cdn.socialhead.io"],
    scriptPatterns: [/socialhead\.io/, /SocialHead/],
    snippetNames: ["socialhead-og", "socialhead-social", "socialhead"],
    cssPatterns: [/socialhead/],
  },
  {
    appName: "SEO King",
    cdnDomains: [],
    scriptPatterns: [/seo-king/, /SEOKing/],
    snippetNames: ["seo-king-meta", "seo-king-og", "seo-king"],
    cssPatterns: [],
  },
  // -------------------------------------------------------------------------
  // Additional Popular Apps
  // -------------------------------------------------------------------------
  {
    appName: "Privy / SMSBump (Yotpo SMS)",
    cdnDomains: ["cdn.smsbump.com", "a.smsbump.com"],
    scriptPatterns: [/smsbump\.com/, /SMSBumpWidget/, /window\.SMSBump/],
    snippetNames: ["smsbump", "smsbump-widget"],
    cssPatterns: [/smsbump/],
  },
  {
    appName: "Nosto",
    cdnDomains: ["connect.nosto.com", "cdn.nosto.com"],
    scriptPatterns: [/nosto\.com/, /nostojs/, /window\.nosto/],
    snippetNames: ["nosto-tagging", "nosto-element", "nosto"],
    cssPatterns: [/nosto/],
  },
  {
    appName: "ShipBob",
    cdnDomains: ["cdn.shipbob.com"],
    scriptPatterns: [/shipbob\.com/, /ShipBobDeliveryDates/],
    snippetNames: ["shipbob-delivery", "shipbob"],
    cssPatterns: [/shipbob/],
  },
  {
    appName: "Attentive",
    cdnDomains: ["cdn.attn.tv", "cdn.attentivemobile.com"],
    scriptPatterns: [/attn\.tv/, /attentive\.js/, /window\.__attentive/],
    snippetNames: ["attentive-tag", "attentive"],
    cssPatterns: [/attentive/],
    isTracker: true,
  },
  {
    appName: "Postscript",
    cdnDomains: ["sdk.postscript.io", "cdn.postscript.io"],
    scriptPatterns: [/postscript\.io/, /PostscriptSDK/, /ps-widget/],
    snippetNames: ["postscript-popup", "postscript"],
    cssPatterns: [/postscript/],
  },
  {
    appName: "Shoelace / AdRoll",
    cdnDomains: ["d.adroll.com", "s.adroll.com"],
    scriptPatterns: [/adroll\.com/, /adroll_adv_id/, /window\.adroll/],
    snippetNames: ["adroll-pixel", "adroll"],
    cssPatterns: [],
    isTracker: true,
  },
  {
    appName: "Tapcart",
    cdnDomains: ["cdn.tapcart.com"],
    scriptPatterns: [/tapcart\.com/, /TapcartSDK/, /window\.tapcart/],
    snippetNames: ["tapcart-banner", "tapcart"],
    cssPatterns: [/tapcart/],
  },
  {
    appName: "Route / Route Protection",
    cdnDomains: ["cdn.routeapp.io", "route-cdn.com"],
    scriptPatterns: [/routeapp\.io/, /route-cdn\.com/, /RouteWidget/],
    snippetNames: ["route-widget", "route-protection", "route"],
    cssPatterns: [/routeapp/],
  },
  {
    appName: "Skio Subscriptions",
    cdnDomains: ["cdn.skio.com"],
    scriptPatterns: [/skio\.com/, /SkioSubscription/],
    snippetNames: ["skio-plan-picker", "skio-widget", "skio"],
    cssPatterns: [/skio/],
  },
  {
    appName: "Affirm / Afterpay",
    cdnDomains: ["cdn1.affirm.com", "js.afterpay.com", "static.afterpay.com"],
    scriptPatterns: [/affirm\.com/, /afterpay\.com/, /window\.affirm/, /AfterpayWidget/],
    snippetNames: ["affirm-messaging", "afterpay-messaging", "afterpay-widget", "affirm"],
    cssPatterns: [/affirm/, /afterpay/],
  },
  {
    appName: "Reamaze",
    cdnDomains: ["cdn.reamaze.com"],
    scriptPatterns: [/reamaze\.com/, /window\._support/, /reamaze\.js/],
    snippetNames: ["reamaze-widget", "reamaze"],
    cssPatterns: [/reamaze/],
  },
];
