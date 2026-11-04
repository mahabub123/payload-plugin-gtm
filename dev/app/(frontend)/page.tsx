import { DemoButtons } from './DemoButtons.js'

export default function Page() {
  return (
    <main>
      <h1>payload-plugin-gtm demo</h1>
      <p>
        Click the buttons, wait ~2 s, then open{' '}
        <a href="/admin/collections/gtm-events">/admin → Data Layer Events</a>.
      </p>
      <DemoButtons />
    </main>
  )
}
