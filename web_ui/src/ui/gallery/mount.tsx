import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '../../styles/theme.css';
import { Gallery } from './Gallery';

/** Dev-only entry: main.tsx reaches this via a dynamic import behind import.meta.env.DEV. */
export function mountGallery(rootElement: HTMLElement): void {
  createRoot(rootElement).render(
    <StrictMode>
      <Gallery />
    </StrictMode>
  );
}
