import '../styles/globals.css'
// MapLibre CSS for client map rendering
import 'maplibre-gl/dist/maplibre-gl.css'
// Prototype design system (verbatim from open_design/assets/app.css).
// Imported last so its base rules (body font/bg, components) win over Tailwind.
import '../styles/prototype.css'
import type { AppProps } from 'next/app'

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
