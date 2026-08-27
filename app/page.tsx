import ExpensiveButton from "./ExpensiveButton";
import { getState } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  const state = await getState();
  const contact = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  const testMode = !process.env.STRIPE_SECRET_KEY;
  return (
    <main className="flex flex-1 flex-col items-center px-4 py-16 font-sans">
      <header className="mb-12 text-center">
        <h1 className="text-4xl font-black tracking-tight">
          The Expensive Button
        </h1>
        <p className="mt-2 max-w-md text-zinc-600 dark:text-zinc-400">
          One button. Pay whatever you want, as long as it beats the last press.
          Your name stays on it until someone pays more.
        </p>
        {testMode && (
          <p className="mt-3 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
            Test mode: no real charges
          </p>
        )}
      </header>
      <ExpensiveButton initial={state} />
      <footer className="mt-20 max-w-md text-center text-xs leading-relaxed text-zinc-500">
        <p>
          All payments are final. You are buying a spot on the button, not a
          chance to win anything; nobody is paid out and there are no prizes.
          Names and links are public and may be removed if they are abusive.
        </p>
        {contact && (
          <p className="mt-2">
            Questions or takedowns:{" "}
            <a href={`mailto:${contact}`} className="underline">
              {contact}
            </a>
          </p>
        )}
      </footer>
    </main>
  );
}
