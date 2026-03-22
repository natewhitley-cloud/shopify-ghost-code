/**
 * Custom type declarations for Polaris web components not yet included
 * in @shopify/polaris-types.
 *
 * The official package registers components in Preact's JSX namespace and
 * HTMLElementTagNameMap, but this project uses React ("jsx": "react-jsx").
 * This file bridges the gap for any missing components.
 */

type PolarisCustomElement = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  // Allow any additional props since these components may accept
  // attributes not covered by standard HTML typings.
  [key: string]: unknown;
};

declare namespace JSX {
  interface IntrinsicElements {
    "s-card": PolarisCustomElement;
    "s-data-table": PolarisCustomElement;
    "s-empty-state": PolarisCustomElement;
    "s-app-nav": PolarisCustomElement;
  }
}
