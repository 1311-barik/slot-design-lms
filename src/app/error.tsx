'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="startup-error"><h1>This page could not be opened.</h1><p>Your saved work is still in the database. Try opening the page again. Text that had not been saved may need to be entered again.</p><button onClick={reset}>Try again</button></main>;
}
