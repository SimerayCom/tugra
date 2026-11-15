/**
 * Pre-paint script (inlined in app/layout.tsx): applies the saved theme, UI scale, page width, navigation style
 * and style to <html> synchronously, before first paint, so a reload never flashes the defaults. Keys and value
 * lists must match lib/appearance.ts (a test pins them). Self-contained: no imports at runtime, no colour maths
 * (a custom theme's derived CSS variables are stored ready-made under `tugra.themeVars`).
 */
export const APPEARANCE_PREPAINT = [
  "try{",
  "var d=document.documentElement,L=localStorage,g=function(k){return L.getItem('tugra.'+k)},p=g('theme')||'dark';",
  "if(p==='system')p=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light';",
  "else if(p==='custom'){var v=JSON.parse(g('themeVars')||'null');if(v)for(var k in v)d.style.setProperty(k,v[k]);else p='dark'}",
  "else if(p!=='light')p='dark';",
  "d.setAttribute('data-theme',p);",
  "var o={uiScale:['80','90','100'],pageWidth:['full','centered'],navStyle:['default','floating'],uiStyle:['flat','3d']};",
  "for(var n in o){var x=g(n);if(x&&o[n].indexOf(x)>-1)d.setAttribute('data-'+n.replace(/[A-Z]/g,function(c){return'-'+c.toLowerCase()}),x)}",
  "}catch(e){}",
].join("");
