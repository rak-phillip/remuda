/**
 * The product glyph for the side navigation, as a data URI.
 *
 * Inlined rather than `require`d from a .svg file because webpack emits an
 * imported SVG as a separate asset and references it by URL. An extension's
 * bundle is served from its own plugin directory, so that URL resolves against
 * the dashboard's origin instead and the icon silently 404s. A data URI has no
 * such dependency.
 *
 * Monochrome and transparent on purpose: the nav renders product SVGs through
 * IconOrSvg, which recolours them per theme with a CSS filter derived from a
 * black source, so a coloured or badged icon comes out muddy. The badged version
 * used for the Extensions install card is `icon.svg` at the repository root.
 */
const NAV_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="M7.3 15.5 A6.5 6.5 0 1 1 16.7 15.5" fill="none" stroke="#000" stroke-width="3" stroke-linecap="round"/>
</svg>`;

export default `data:image/svg+xml;utf8,${ encodeURIComponent(NAV_ICON) }`;
