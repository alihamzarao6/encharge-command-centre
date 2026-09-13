import type { Section } from './Shell.js';
import type { ReactElement } from 'react';

/** An honest placeholder: what this section will be, and which stage delivers it. */
export function NotYet({ section }: { readonly section: Section }): ReactElement {
  return (
    <section className="notyet" aria-labelledby="notyet-title">
      <div className="card notyet__card">
        <span className="badge">{section.stage} · not yet built</span>
        <h1 id="notyet-title" className="notyet__title">
          {section.label}
        </h1>
        <p>{section.blurb}</p>
        <p className="muted">
          This section arrives with {section.stage}. Until then the Assistant is the live part of
          the Command Centre.
        </p>
      </div>
    </section>
  );
}
