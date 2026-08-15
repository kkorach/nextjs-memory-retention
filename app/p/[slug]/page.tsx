import { headers } from 'next/headers';
import { Suspense } from 'react';
import { getItems, type Item } from '../../data';

// SECTIONS independent Suspense boundaries, each opening its own chain of nested `use cache` scopes.
// Breadth sets how fast the heap fills; CACHE_DEPTH (see data.ts) sets how much each render retains.
const SECTIONS = Number(process.env.SECTIONS ?? 30);

// Whether each section performs a dynamic read before its cached read. Set USE_HEADERS=0 to drop it.
const USE_HEADERS = process.env.USE_HEADERS !== '0';

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  return (
    <main>
      <h1>use cache retention repro</h1>
      {Array.from({ length: SECTIONS }, (_, i) => (
        <Suspense key={i} fallback={<p>loading {i}…</p>}>
          <Section params={params} index={i} />
        </Suspense>
      ))}
    </main>
  );
}

async function Section({ params, index }: { params: Promise<{ slug: string }>; index: number }) {
  const { slug } = await params;
  const ua = USE_HEADERS ? ((await headers()).get('user-agent') ?? 'none') : 'skipped';
  const items = await getItems(`${slug}#${index}`);

  return (
    <section>
      <h2>
        {slug} · {index} · ua {ua.length}
      </h2>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <b>{item.name}</b>
            <span>{item.blurb}</span>
            <code>{item.values.join(',')}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
