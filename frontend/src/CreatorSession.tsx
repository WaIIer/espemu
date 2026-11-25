import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, Folder, FolderOpen, FolderPlus, Home } from 'lucide-react';

export type CreatorSession = { token: string; mode: 'create' | 'build' | 'run'; location: string; name: string; home: string; completed: string | null };
type Check = { ok: boolean; directory?: string; error?: string; location: string; name: string };
type Listing = { path: string; parent: string | null; folders: string[]; truncated: boolean };

const call = async <Value,>(session: CreatorSession, path: string, init: RequestInit = {}): Promise<Value> => {
  const response = await fetch(path, { ...init, headers: { ...init.headers, 'X-ESPEmu-Creator': session.token } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as Value;
};

/** Reads the one-time session that `espemu new --web` puts in the URL fragment. */
export function useCreatorSession() {
  const [session, setSession] = useState<CreatorSession | null>(null);
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('session');
    if (!token) return;
    fetch('/api/creator-session', { headers: { 'X-ESPEmu-Creator': token } })
      .then(response => response.ok ? response.json() : null)
      .then(value => { if (value?.location) setSession({ token, mode: value.mode, location: value.location, name: value.name, home: value.home, completed: null }); })
      .catch(() => {});
  }, []);
  return [session, setSession] as const;
}

function FolderPicker({ session, start, choose, close }: { session: CreatorSession; start: string; choose: (path: string) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), latest = useRef(0);
  const [listing, setListing] = useState<Listing | null>(null), [typed, setTyped] = useState(start), [error, setError] = useState('');
  async function open(path: string) {
    const request = ++latest.current;
    try {
      const next = await call<Listing>(session, `/api/creator-folders?path=${encodeURIComponent(path)}`);
      if (request === latest.current) { setListing(next); setTyped(next.path); setError(''); }
    } catch (failure) { if (request === latest.current) setError(failure instanceof Error ? failure.message : 'That folder cannot be opened.'); }
  }
  useEffect(() => { dialog.current?.showModal(); void open(start).then(() => undefined); }, []);
  return <dialog ref={dialog} className="folder-picker" aria-label="Choose project location" onClose={close}>
    <h2><FolderOpen size={18}/>Choose location</h2>
    <form className="folder-picker-path" onSubmit={event => { event.preventDefault(); void open(typed); }}>
      <button type="button" className="icon-button" aria-label="Parent folder" disabled={!listing?.parent} onClick={() => listing?.parent && void open(listing.parent)}><ArrowUp size={16}/></button>
      <button type="button" className="icon-button" aria-label="Home folder" onClick={() => void open(session.home)}><Home size={16}/></button>
      <input aria-label="Folder path" value={typed} onChange={event => setTyped(event.target.value)} spellCheck={false}/>
      <button type="submit">Go</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <ul className="folder-picker-list" aria-label="Folders">
      {listing?.folders.map(name => <li key={name}><button type="button" onClick={() => void open(`${listing.path.replace(/\/$/, '')}/${name}`)}><Folder size={15}/>{name}</button></li>)}
      {listing && !listing.folders.length && <li className="meta">No subfolders</li>}
      {listing?.truncated && <li className="meta">This list shows the first 500 folders. Type a path to open another one.</li>}
    </ul>
    <div className="runtime-device-tools">
      <button type="button" className="primary-button" disabled={!listing} onClick={() => { if (listing) choose(listing.path); dialog.current?.close(); }}><Check size={16}/>Use this folder</button>
      <button type="button" onClick={() => dialog.current?.close()}>Cancel</button>
    </div>
  </dialog>;
}

type Submit = { pending: boolean; error: string };
export type NewProject = {
  session: CreatorSession; name: string; setName(value: string): void; useDefault: boolean; setUseDefault(value: boolean): void;
  custom: string; setCustom(value: string): void; location: string; check: Check | null; submit: Submit; create(): Promise<void>;
};

/** State shared by the name and location card at the top and the create card at the end of the page. */
export function useNewProject(session: CreatorSession | null, setSession: (next: CreatorSession) => void, exported: string): NewProject | null {
  const [name, setName] = useState(session?.name ?? ''), [useDefault, setUseDefault] = useState(true), [custom, setCustom] = useState(session?.location ?? '');
  const [result, setCheck] = useState<Check | null>(null), [submit, setSubmit] = useState<Submit>({ pending: false, error: '' });
  useEffect(() => { if (session) { setName(session.name); setCustom(session.location); } }, [session?.token]);
  const location = useDefault ? session?.location ?? '' : custom;
  // A result for earlier inputs is not shown or trusted while the new ones are checked.
  const check = result && result.location === location && result.name === name ? result : null;
  useEffect(() => { setSubmit(previous => previous.error ? { ...previous, error: '' } : previous); }, [location, name]);
  useEffect(() => {
    if (!session || session.completed) return;
    let current = true;
    const timer = setTimeout(() => {
      call<{ ok: boolean; directory?: string; error?: string }>(session, `/api/creator-check?location=${encodeURIComponent(location)}&name=${encodeURIComponent(name)}`)
        .then(value => { if (current) setCheck({ ...value, location, name }); })
        .catch(() => { if (current) setCheck({ ok: false, error: 'The setup command has stopped. Run it again.', location, name }); });
    }, 200);
    return () => { current = false; clearTimeout(timer); };
  }, [location, name, session]);
  if (!session) return null;
  async function create() {
    setSubmit({ pending: true, error: '' });
    try {
      const created = await call<{ directory: string }>(session!, '/api/creator-submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ location, name, config: JSON.parse(exported) }) });
      setSession({ ...session!, completed: created.directory });
      setSubmit({ pending: false, error: '' });
    } catch (failure) {
      setSubmit({ pending: false, error: failure instanceof TypeError ? 'The setup command has stopped. Run it again.' : failure instanceof Error ? failure.message : 'Setup failed.' });
    }
  }
  return { session, name, setName, useDefault, setUseDefault, custom, setCustom, location, check, submit, create };
}

/** Project name and location, at the top of the page like a new-project dialog. */
export function NewProjectCard({ project }: { project: NewProject }) {
  const { session, name, setName, useDefault, setUseDefault, custom, setCustom, location, check } = project;
  const [picking, setPicking] = useState(false);
  return <section className="creator-card creator-session" aria-label="New project">
    <h2><FolderPlus size={17}/>New project</h2>
    <div className="creator-fields">
      <label>Project name<input aria-label="Project name" value={name} maxLength={64} spellCheck={false} disabled={!!session.completed} onChange={event => setName(event.target.value)}/></label>
    </div>
    <label className="creator-check"><input type="checkbox" checked={useDefault} disabled={!!session.completed} onChange={event => setUseDefault(event.target.checked)}/>Use default location</label>
    {useDefault ? <p className="meta">Location: <code>{session.location}</code></p>
      : <div className="creator-location">
        <label>Location<input aria-label="Location" value={custom} spellCheck={false} disabled={!!session.completed} onChange={event => setCustom(event.target.value)}/></label>
        <button type="button" disabled={!!session.completed} onClick={() => setPicking(true)}><FolderOpen size={16}/>Browse…</button>
      </div>}
    {!session.completed && <p className="meta" data-project-path>{check?.ok ? <>Creates <code>{check.directory}</code></> : check?.error ? <span className="inline-error" role="alert">{check.error}</span> : 'Checking the location.'}</p>}
    {picking && <FolderPicker session={session} start={location} choose={path => { setCustom(path); setUseDefault(false); }} close={() => setPicking(false)}/>}
  </section>;
}

/** The last step of the page: where the project goes and the button that creates it. */
export function CreateProjectCard({ project, valid }: { project: NewProject; valid: boolean }) {
  const { session, check, submit, create } = project;
  if (session.completed) return <section className="creator-card creator-session" aria-label="Create project">
    <h2><Check size={17}/>Project created</h2>
    <p role="status">Created <code>{session.completed}</code>. The setup command continues in your terminal, and you can close this tab.</p>
  </section>;
  return <section className="creator-card creator-session" aria-label="Create project">
    <h2><FolderPlus size={17}/>Create project</h2>
    <p className="meta">{check?.ok ? <>Creates <code>{check.directory}</code></> : 'Choose a valid name and location at the top of the page.'}</p>
    <p className="meta">{session.mode === 'run' ? 'The setup command then builds the firmware and starts the workbench.' : session.mode === 'build' ? 'The setup command then builds the firmware.' : 'The setup command creates the files and returns to your shell.'}</p>
    {!valid && <p className="meta">Fix the circuit configuration to enable Create project.</p>}
    <button type="button" className="primary-button" disabled={!valid || !check?.ok || submit.pending} onClick={() => void create()}><FolderPlus size={16}/>{submit.pending ? 'Creating' : 'Create project'}</button>
    {submit.error && <p className="inline-error" role="alert">{submit.error}</p>}
  </section>;
}
