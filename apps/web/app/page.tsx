"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { AccountInfo } from "@azure/msal-browser";
import { apiRequest, configured, environment, getAuth } from "./auth";

type Role = "Member" | "Officer" | "Advisor" | "Administrator";
type Member = { id: string; name: string; email: string; role: Role; bio: string | null; interests: string | null };
type ClubEvent = { id: string; title: string; description: string; kind: string; location: string; starts_at: string; ends_at: string; capacity: number; cancelled_at: string | null; registered_count: number; registered: boolean };
type Registration = { id: string; event_id: string; title: string; kind: string; starts_at: string; ends_at: string; location: string; cancelled_at: string | null; checked_in_at: string | null; checkin_token: string };
type Notification = { id: string; title: string; body: string; read_at: string | null; created_at: string };
type Report = { members: number; events: number; registrations: number; attendance: number; engagement_rate: number; by_kind: { kind: string; registrations: number; attendance: number }[]; by_event: { id: string; title: string; registrations: number; attendance: number }[]; by_member: { id: string; name: string; registrations: number; attendance: number }[] };
type Tab = "Events" | "My participation" | "Profile" | "Notifications" | "Reports" | "Members" | "Check-in";
type IconName = "grid" | "calendar" | "ticket" | "user" | "bell" | "chart" | "users" | "scan" | "arrow" | "spark" | "logout" | "pin" | "clock";
const kinds = ["Workshop", "Hackathon", "Competition", "Mentoring", "Other"];
const roles: Role[] = ["Member", "Officer", "Advisor", "Administrator"];
const tabIcons: Record<Tab, IconName> = { Events: "calendar", "My participation": "ticket", Profile: "user", Notifications: "bell", Reports: "chart", Members: "users", "Check-in": "scan" };
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const time = (value: string) => new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Please try again.";
const checkinWindowOpen = (endsAt: string) => new Date().getTime() <= new Date(endsAt).getTime() + 2 * 60 * 60 * 1000;
const localDate = (value: string) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3" /></>,
    ticket: <><path d="M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Z" /><path d="M14 8v2m0 4v2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    bell: <><path d="M5 17h14l-2-4V9A5 5 0 0 0 7 9v4l-2 4Zm5 3h4" /></>,
    chart: <><path d="M4 3v17h17M8 15v-4m5 4V7m5 8v-6" /></>,
    users: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3m1-15a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 5" /></>,
    scan: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5M3 12h18M8 8h2m4 8h2" /></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></>,
    logout: <><path d="M9 4H4v16h5m0-8h12m-5-5 5 5-5 5" /></>,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name="spark" size={26} /></span><h3>{title}</h3><p>{children}</p></div>;
}

export default function Home() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [ready, setReady] = useState(!configured);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!configured) return;
    let active = true;
    getAuth().then(auth => {
      if (active) setAccount(auth.getActiveAccount() || auth.getAllAccounts()[0] || null);
    }).catch(e => { if (active) setError(errorText(e)); }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);
  async function login() {
    setBusy(true); setError("");
    try {
      const auth = await getAuth();
      const result = await auth.loginPopup({ scopes: [environment.scope!], prompt: "select_account" });
      auth.setActiveAccount(result.account);
      setAccount(result.account);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  async function logout() {
    const previous = account;
    setAccount(null);
    setBusy(true); setError("");
    try {
      const auth = await getAuth();
      await auth.logoutPopup({ account: previous, postLogoutRedirectUri: window.location.origin });
    } catch {
      const auth = await getAuth();
      await auth.clearCache({ account: previous || undefined });
      setError("You are signed out here. Microsoft sign-out did not complete; close your Microsoft session on shared devices.");
    } finally { setBusy(false); }
  }
  if (account) return <Dashboard key={account.homeAccountId} account={account} logout={logout} />;
  return <div className="welcome-page">
    <header className="welcome-header"><Brand /><span className="header-note">A space for curious minds.</span></header>
    <main id="main" className="welcome-main">
      <section className="welcome-copy">
        <div className="eyebrow"><span className="live-dot" /> LEARN. CONNECT. CREATE.</div>
        <h1>Big ideas.<br />Real connections.<br /><span>Your AI community.</span></h1>
        <p className="welcome-description">The next chapter of AI starts with us. Discover hands-on experiences, meet your people, and turn curiosity into something extraordinary.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {!configured ? <div className="setup-panel"><h2>Let’s connect your club</h2><p>Microsoft sign-in needs to be configured before you can access club data. No sample accounts or data are used.</p><p>Set these public environment variables in <code>apps/web/.env.local</code>, then restart the development server (or rebuild the production app):</p><ul>{["NEXT_PUBLIC_ENTRA_CLIENT_ID", "NEXT_PUBLIC_ENTRA_TENANT_ID", "NEXT_PUBLIC_ENTRA_API_SCOPE"].map(key => <li key={key}><code>{key}</code></li>)}</ul><p>Use your API’s delegated <code>access_as_user</code> scope. Register this site’s origin as an Entra SPA redirect URI. Your administrator can also set <code>NEXT_PUBLIC_API_URL</code> (default: localhost:4000) and <code>NEXT_PUBLIC_ENTRA_REDIRECT_URI</code>. Never put a client secret in the browser.</p></div> :
          <><button className="button primary sign-in" onClick={login} disabled={!ready || busy}><span className="microsoft-mark"><i /><i /><i /><i /></span>{!ready ? "Connecting…" : busy ? "Opening Microsoft…" : "Continue with Microsoft"}<Icon name="arrow" /></button><p className="sign-in-note">Your club account. One secure sign-in.</p></>}
      </section>
      <section className="welcome-art" aria-label="Explore, build, and belong with AI Club">
        <div className="art-grid" /><div className="orbit orbit-one" /><div className="orbit orbit-two" />
        <div className="art-star star-one">✳</div><div className="art-star star-two">✧</div>
        <div className="art-center"><span>AI</span><small>HUMAN CURIOSITY.<br />LIMITLESS POSSIBILITY.</small></div>
        <div className="floating-label label-one"><span className="label-icon">↗</span> Explore what’s next</div>
        <div className="floating-label label-two"><Icon name="users" /> Better, together.</div>
        <div className="art-footer"><span>YOUR IDEAS BELONG HERE</span><span>↗</span></div>
      </section>
      <section className="welcome-features" aria-label="Club features">
        {[["calendar", "Find your next spark", "Workshops, hackathons, mentoring, and more."], ["ticket", "Make it happen", "Register, save to Outlook, and check in with your QR."], ["users", "Stay in the loop", "Your club profile, updates, and participation in one place."]].map(([icon, title, text]) => <div key={title}><span className="feature-icon"><Icon name={icon as IconName} /></span><div><h2>{title}</h2><p>{text}</p></div></div>)}
      </section>
    </main>
    <footer className="welcome-footer"><span>AI Club · Built around community.</span><span>Powered by curiosity. Secured by Microsoft.</span></footer>
  </div>;
}

function Brand() {
  return <div className="brand"><span className="brand-symbol"><Icon name="spark" size={25} /></span><span>AI Club<span className="brand-subtitle">MEMBER PORTAL</span></span></div>;
}

function Dashboard({ account, logout }: { account: AccountInfo; logout: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("Events");
  const [me, setMe] = useState<Member | null>(null);
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All");
  const [editor, setEditor] = useState<ClubEvent | "new" | null>(null);
  const [qr, setQr] = useState<Registration | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<ClubEvent | null>(null);
  const controller = useRef<AbortController | null>(null);
  const refreshVersion = useRef(0);
  const request = useCallback(async (path: string, options?: RequestInit, allowInteraction = true) => {
    return apiRequest(account, path, { ...options, signal: controller.current?.signal }, allowInteraction);
  }, [account]);
  const refresh = useCallback(async (allowInteraction = true) => {
    const version = ++refreshVersion.current;
    const [profile, eventData, participation, updates] = await Promise.all([
      request("/api/me", undefined, allowInteraction).then(r => r.json()), request("/api/events", undefined, allowInteraction).then(r => r.json()),
      request("/api/me/registrations", undefined, allowInteraction).then(r => r.json()), request("/api/notifications", undefined, allowInteraction).then(r => r.json()),
    ]);
    if (controller.current?.signal.aborted || version !== refreshVersion.current) return;
    setMe(profile); setEvents(eventData); setRegistrations(participation); setNotifications(updates);
    setTab(current => {
      if (current === "Check-in" && profile.role !== "Officer" && profile.role !== "Administrator") return "Events";
      if ((current === "Members" || current === "Reports") && profile.role === "Member") return "Events";
      return current;
    });
  }, [request]);
  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    let polling = false;
    refresh().catch(e => { if (!abort.signal.aborted) setError(errorText(e)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    const poll = async () => {
      if (polling || abort.signal.aborted || document.visibilityState !== "visible") return;
      polling = true;
      try {
        await refresh(false);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorText(e));
      } finally {
        polling = false;
      }
    };
    const interval = window.setInterval(poll, 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      abort.abort();
    };
  }, [refresh]);
  const staff = me?.role === "Officer" || me?.role === "Administrator";
  const reporting = staff || me?.role === "Advisor";
  useEffect(() => {
    if ((tab !== "Members" && tab !== "Reports") || !reporting) return;
    let active = true;
    request(tab === "Reports" ? "/api/reports" : "/api/members").then(r => r.json()).then(data => {
      if (active) { if (tab === "Reports") setReport(data); else setMembers(data); }
    }).catch(e => { if (active) setError(errorText(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab, reporting, request]);
  async function mutate(action: () => Promise<unknown>, message: string) {
    if (busy) return;
    setBusy(true); setError(""); setSuccess("");
    let saved = false;
    try {
      await action();
      saved = true;
      await refresh();
      if (tab === "Members") setMembers(await request("/api/members").then(r => r.json()));
      setSuccess(message);
      return true;
    } catch (e) {
      if (!controller.current?.signal.aborted) {
        setError(`${saved ? "Your change was saved, but refreshing failed. " : ""}${errorText(e)}`);
        if (saved) setSuccess(message);
      }
      return saved;
    }
    finally { setBusy(false); }
  }
  async function download(path: string, filename: string) {
    setBusy(true); setError("");
    try {
      const response = await request(path);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSuccess(`${filename} downloaded.`);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }
  const tabs: Tab[] = ["Events", "My participation", "Profile", "Notifications", ...(reporting ? ["Reports", "Members"] as Tab[] : []), ...(staff ? ["Check-in"] as Tab[] : [])];
  const unread = notifications.filter(n => !n.read_at).length;
  const upcoming = events.filter(e => !e.cancelled_at && new Date(e.starts_at) > new Date());
  const attended = registrations.filter(r => r.checked_in_at).length;
  const visibleEvents = events.filter(e => (filter === "All" || e.kind === filter) && `${e.title} ${e.description} ${e.location}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  function selectTab(next: Tab) {
    if (next === tab) return;
    setTab(next); setError(""); setSuccess("");
    setLoading(next === "Reports" || next === "Members");
  }
  async function retry() {
    await mutate(async () => {
      if (tab === "Reports" && reporting) setReport(await request("/api/reports").then(r => r.json()));
      if (tab === "Members" && reporting) setMembers(await request("/api/members").then(r => r.json()));
    }, "Data refreshed.");
  }
  return <div className="app-shell">
    <a href="#main" className="skip-link">Skip to content</a>
    <aside className="sidebar"><Brand /><div className="nav-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{tabs.map(item => <button key={item} className={`nav-item ${tab === item ? "active" : ""}`} aria-current={tab === item ? "page" : undefined} onClick={() => selectTab(item)}><Icon name={tabIcons[item]} /><span>{item}</span>{item === "Notifications" && unread > 0 && <span className="nav-count">{unread}</span>}</button>)}</nav><div className="sidebar-note"><Icon name="spark" /><h3>Small steps. Big ideas.</h3><p>Your next breakthrough might start with a conversation.</p></div><button className="nav-item logout" onClick={logout}><Icon name="logout" />Sign out</button></aside>
    <div className="workspace">
      <header className="topbar"><span className="breadcrumb">Workspace <span>/</span> <strong>{tab}</strong></span><div className="topbar-right"><button className="icon-button" aria-label={`Notifications, ${unread} unread`} onClick={() => selectTab("Notifications")}><Icon name="bell" />{unread > 0 && <i className="notification-dot" />}</button><span className="header-divider" /><div className="account-info"><span className="avatar">{(me?.name || account.name || "A").slice(0, 1).toUpperCase()}</span><div><strong>{me?.name || account.name || "Club member"}</strong><small>{me?.role || "Connecting…"}</small></div></div></div></header>
      <main id="main" className="dashboard-main">
        <div className="page-heading"><div><p className="eyebrow">THE AI CLUB COMMUNITY</p><h1>{tab === "Events" ? `Good to see you${me?.name ? `, ${me.name.split(" ")[0]}` : ""}` : tab}<span className="heading-dot">.</span></h1><p>{({ Events: "A little curiosity. A world of possibilities. Find your next experience.", "My participation": "Your experiences, all in one place. Keep learning, keep showing up.", Profile: "Make yourself known. Great connections start with a little introduction.", Notifications: "The latest from your community. Never miss a moment.", Reports: "Real participation. Meaningful insights. See your community in action.", Members: "Meet the people making our community possible.", "Check-in": "Welcome your community. Record attendance with a member’s QR token." })[tab]}</p></div>{staff && tab === "Events" && <button className="button primary" onClick={() => setEditor("new")}>+ Create event</button>}</div>
        {error && <div className="notice error" role="alert"><span>{error}</span><button className="text-button" onClick={retry} disabled={busy}>Retry</button></div>}
        {success && <div className="notice success" role="status">{success}</div>}
        {loading && <div className="loading" role="status"><span className="spinner" />Loading your club workspace…</div>}
        {!loading && !me && <Empty title="We couldn’t connect to your club">Check that the API is available and that your Microsoft account has access, then choose Retry above.</Empty>}
        {me && tab === "Events" && <>
          <section className="dashboard-hero"><div><span className="hero-pill"><Icon name="spark" size={14} /> BUILT FOR WHAT’S NEXT</span><h2>Curiosity brings us together.<br />Let’s see where it takes us.</h2><p>Learn something new. Build something bold. Find your people.</p><button className="hero-link" onClick={() => document.getElementById("event-list")?.scrollIntoView({ behavior: "smooth" })}>Explore events <Icon name="arrow" size={17} /></button></div><div className="hero-visual" aria-hidden="true"><div className="hero-orbit" /><span>✳</span><small>IDEAS INTO<br />IMPACT</small></div></section>
          <section className="stat-grid" aria-label="Your club at a glance"><Stat label="Upcoming events" value={upcoming.length} icon="calendar" detail="More ways to get involved" /><Stat label="Your registrations" value={registrations.length} icon="ticket" detail="Your learning journey" /><Stat label="Events attended" value={attended} icon="chart" detail="Every experience counts" /></section>
          <section id="event-list" className="events-section"><div className="section-title"><div><h2>Discover events <span className="count-pill">{events.length}</span></h2><p>Find the experience that speaks to you.</p></div><label className="search-input"><span aria-hidden="true">⌕</span><input aria-label="Search events" placeholder="Search events…" value={search} onChange={e => setSearch(e.target.value)} /></label></div><div className="filters" aria-label="Filter by event type">{["All", ...kinds].map(kind => <button key={kind} onClick={() => setFilter(kind)} className={filter === kind ? "selected" : ""} aria-pressed={filter === kind}>{kind === "All" ? "All events" : kind}</button>)}</div><p className="live-refresh">Availability, participation, and notifications refresh every 15 seconds while this tab is visible. Spots are confirmed when you register.</p>
          {visibleEvents.length === 0 ? <Empty title={events.length ? "No events match your search" : "Something great is on the horizon"}>{events.length ? "Try a different keyword or event type." : "New club events will appear here. Check back soon for your next opportunity to connect."}</Empty> : <div className="event-grid">{visibleEvents.map(event => {
            const past = new Date(event.starts_at) <= new Date();
            const full = event.registered_count >= event.capacity;
            const cancelled = Boolean(event.cancelled_at);
            return <article className="event-card" key={event.id}><div className={`event-art art-${kinds.indexOf(event.kind)}`} aria-hidden="true"><span className="event-art-word">{event.kind === "Hackathon" ? "{ build }" : event.kind === "Workshop" ? "make / learn" : event.kind === "Competition" ? "challenge ↗" : event.kind === "Mentoring" ? "grow together" : "explore ✳"}</span><span className="event-art-shape">✳</span></div><div className="event-content"><div className="card-label-row"><span className={`badge kind-${kinds.indexOf(event.kind)}`}>{event.kind}</span><span className={`event-state ${cancelled || past || full ? "" : "open"}`}>{cancelled ? "Cancelled" : past ? "Started / past" : full ? "Fully booked" : "Open for registration"}</span></div><h3>{event.title}</h3><p className="event-description">{event.description}</p><div className="event-meta"><span><Icon name="calendar" size={16} />{date(event.starts_at)}</span><span><Icon name="clock" size={16} />{time(event.starts_at)} – {date(event.starts_at) !== date(event.ends_at) ? `${date(event.ends_at)} · ` : ""}{time(event.ends_at)}</span><span><Icon name="pin" size={16} />{event.location}</span></div><div className="capacity"><span>{Math.max(0, event.capacity - event.registered_count)} spots left</span><span>{event.registered_count} / {event.capacity}</span></div><div className="capacity-track" aria-hidden="true"><span style={{ width: `${Math.min(100, event.capacity > 0 ? event.registered_count / event.capacity * 100 : 100)}%` }} /></div><div className="card-actions"><button className={`button ${event.registered ? "secondary" : "primary"}`} disabled={busy || cancelled || past || (!event.registered && full)} onClick={() => mutate(() => request(`/api/events/${event.id}/register`, { method: event.registered ? "DELETE" : "POST" }), event.registered ? "Registration cancelled." : "You’re registered! Find your QR in My participation.")}>{event.registered ? "Cancel registration" : cancelled ? "Event cancelled" : past ? "Registration closed" : full ? "Event full" : "Register now"}{!event.registered && !cancelled && !past && !full && <Icon name="arrow" size={16} />}</button><button className="icon-button" disabled={busy} aria-label={`Download Outlook calendar for ${event.title}`} title="Add to Outlook calendar" onClick={() => download(`/api/events/${event.id}/calendar`, "ai-club-event.ics")}><Icon name="calendar" /></button></div>{staff && <div className="staff-actions"><button className="text-button" onClick={() => setEditor(event)}>Edit event</button><button className="text-button danger-text" disabled={cancelled || busy} onClick={() => setConfirmCancel(event)}>Cancel event</button></div>}</div></article>;
          })}</div>}</section>
        </>}
        {me && tab === "My participation" && <section className="panel">{registrations.length === 0 ? <Empty title="Your journey starts here">Register for an event to see it here, save it to your calendar, and access your personal check-in QR.</Empty> : registrations.map(r => <article className="participation-row" key={r.id}><div className="date-tile"><strong>{new Date(r.starts_at).getDate()}</strong><span>{new Date(r.starts_at).toLocaleDateString(undefined, { month: "short" })}</span></div><div className="participation-detail"><span className="badge">{r.kind}</span><h2>{r.title}</h2><p>{date(r.starts_at)} · {time(r.starts_at)} · {r.location}</p><span className={`attendance-label ${r.checked_in_at ? "checked" : ""}`}>{r.cancelled_at ? "Event cancelled" : r.checked_in_at ? `Attended · ${date(r.checked_in_at)}` : new Date(r.ends_at) < new Date() ? checkinWindowOpen(r.ends_at) ? "Ended · Late check-in available" : "Ended · Not checked in" : "Registered · See you there"}</span></div><div className="row-actions"><button className="button secondary" disabled={busy} onClick={() => download(`/api/events/${r.event_id}/calendar`, "ai-club-event.ics")}>Calendar</button><button className="button primary" disabled={Boolean(r.cancelled_at || r.checked_in_at) || !checkinWindowOpen(r.ends_at)} onClick={() => setQr(r)}><Icon name="scan" size={17} />Check-in QR</button>{!r.cancelled_at && new Date(r.starts_at) > new Date() && <button className="text-button danger-text" disabled={busy} onClick={() => mutate(() => request(`/api/events/${r.event_id}/register`, { method: "DELETE" }), "Registration cancelled.")}>Cancel registration</button>}</div></article>)}</section>}
        {me && tab === "Profile" && <ProfileForm key={`${me.id}-${me.name}-${me.bio}-${me.interests}`} me={me} busy={busy} save={body => mutate(() => request("/api/me", { method: "PATCH", body: JSON.stringify(body) }), "Your profile is updated.")} />}
        {me && tab === "Notifications" && <section className="panel">{notifications.length === 0 ? <Empty title="You’re all caught up">Club updates and event reminders will appear here.</Empty> : notifications.map(n => <article className={`notification-row ${n.read_at ? "" : "unread"}`} key={n.id}><span className="feature-icon"><Icon name="bell" /></span><div><h2>{n.title}{!n.read_at && <span className="unread-label">New</span>}</h2><p>{n.body}</p><small>{date(n.created_at)} · {time(n.created_at)}</small></div>{!n.read_at && <button className="button secondary" disabled={busy} onClick={() => mutate(() => request(`/api/notifications/${n.id}/read`, { method: "PATCH" }), "Notification marked as read.")}>Mark as read</button>}</article>)}</section>}
        {me && tab === "Reports" && reporting && report && <><div className="section-title"><h2>Community overview</h2><button className="button primary" disabled={busy} onClick={() => download("/api/reports/export", "ai-club-report.csv")}>Export CSV <Icon name="arrow" size={16} /></button></div><div className="stat-grid report-stats"><Stat label="Members" value={report.members} icon="users" /><Stat label="Events" value={report.events} icon="calendar" /><Stat label="Registrations" value={report.registrations} icon="ticket" /><Stat label="Attendance" value={report.attendance} icon="scan" /><Stat label="Engagement rate" value={Number(report.engagement_rate).toLocaleString(undefined, { style: "percent", maximumFractionDigits: 1 })} icon="chart" /></div><ReportTable title="By event type" rows={report.by_kind.map(r => ({ label: r.kind, ...r }))} /><ReportTable title="By event" rows={report.by_event.map(r => ({ label: r.title, ...r }))} /><ReportTable title="By member" rows={report.by_member.map(r => ({ label: r.name, ...r }))} /></>}
        {me && tab === "Members" && reporting && <section className="panel"><div className="section-title panel-title"><h2>Club directory <span className="count-pill">{members.length}</span></h2></div>{members.length === 0 && !loading ? <Empty title="No members to display">Your club directory will appear here.</Empty> : <div className="table-scroll"><table><caption className="sr-only">Club members and roles</caption><thead><tr><th scope="col">Member</th><th scope="col">Interests</th><th scope="col">Role</th></tr></thead><tbody>{members.map(m => <tr key={m.id}><td><strong>{m.name}</strong><small>{m.email}</small>{m.bio && <p className="member-bio">{m.bio}</p>}</td><td>{m.interests || "Not added yet"}</td><td>{me.role === "Administrator" ? <select aria-label={`Role for ${m.name}`} value={m.role} disabled={busy} onChange={e => mutate(() => request(`/api/members/${m.id}/role`, { method: "PATCH", body: JSON.stringify({ role: e.target.value }) }), `${m.name}’s role updated.`)}>{roles.map(role => <option key={role}>{role}</option>)}</select> : <span className="badge">{m.role}</span>}</td></tr>)}</tbody></table></div>}</section>}
        {me && tab === "Check-in" && staff && <CheckinForm busy={busy} submit={token => mutate(() => request("/api/attendance/check-in", { method: "POST", body: JSON.stringify({ token }) }), "Attendance recorded. Welcome to the event!")} />}
        <footer className="dashboard-footer"><span>AI Club · A little curiosity goes a long way.</span><span>Learn. Connect. Create.</span></footer>
      </main>
    </div>
    {editor && <Modal title={editor === "new" ? "Create an event" : "Edit event"} close={() => { if (!busy) setEditor(null); }}><EventForm event={editor === "new" ? undefined : editor} busy={busy} save={async body => { const ok = await mutate(() => request(editor === "new" ? "/api/events" : `/api/events/${editor.id}`, { method: editor === "new" ? "POST" : "PATCH", body: JSON.stringify(body) }), editor === "new" ? "Event created. Let the connections begin!" : "Event updated."); if (ok) setEditor(null); }} />{error && <p className="form-error" role="alert">{error}</p>}</Modal>}
    {confirmCancel && <Modal title="Cancel this event?" close={() => { if (!busy) setConfirmCancel(null); }}><p>Cancel <strong>{confirmCancel.title}</strong>? Cancellation is permanent. Members will no longer be able to register, and existing registrations will show the cancellation.</p><div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirmCancel(null)}>Keep event</button><button className="button danger" disabled={busy} onClick={async () => { const ok = await mutate(() => request(`/api/events/${confirmCancel.id}`, { method: "PATCH", body: JSON.stringify({ cancelled: true }) }), "Event cancelled."); if (ok) setConfirmCancel(null); }}>{busy ? "Cancelling…" : "Cancel event"}</button></div>{error && <p role="alert" className="form-error">{error}</p>}</Modal>}
    {qr && <Modal title="Your event check-in" close={() => setQr(null)}><QrCode registration={qr} request={request} /></Modal>}
  </div>;
}

function Stat({ label, value, icon, detail }: { label: string; value: string | number; icon: IconName; detail?: string }) {
  return <div className="stat-card"><div><span className="stat-label">{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div><span className="stat-icon"><Icon name={icon} size={22} /></span></div>;
}

function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={e => { e.preventDefault(); close(); }}><div className="modal-heading"><h2 id="modal-title">{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}>✕</button></div>{children}</dialog>;
}

function EventForm({ event, busy, save }: { event?: ClubEvent; busy: boolean; save: (body: Record<string, unknown>) => Promise<void> }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError("");
    const data = new FormData(e.currentTarget);
    const start = new Date(String(data.get("starts_at"))); const end = new Date(String(data.get("ends_at")));
    if (end <= start) { setError("The end date must be after the start date."); return; }
    if (!event && start <= new Date()) { setError("Choose a future start date for your event."); return; }
    await save({ title: String(data.get("title")).trim(), description: String(data.get("description")).trim(), kind: data.get("kind"), location: String(data.get("location")).trim(), starts_at: start.toISOString(), ends_at: end.toISOString(), capacity: Number(data.get("capacity")) });
  }
  return <form onSubmit={submit} className="stack-form"><p className="form-intro">Bring your community together. All times use your local time zone.</p><label>Event title<input name="title" required maxLength={200} defaultValue={event?.title} placeholder="Give your event a memorable name" /></label><div className="form-grid"><label>Event type<select name="kind" defaultValue={event?.kind || "Workshop"}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label><label>Capacity<input name="capacity" type="number" min={Math.max(1, event?.registered_count || 1)} max={100000} required defaultValue={event?.capacity || 30} /></label></div><label>Description<textarea name="description" rows={4} required maxLength={10000} defaultValue={event?.description} placeholder="What will members learn, build, or experience?" /></label><label>Location<input name="location" required maxLength={300} defaultValue={event?.location} placeholder="Room, venue, or meeting link" /></label><div className="form-grid"><label>Starts (local time)<input type="datetime-local" name="starts_at" required defaultValue={event ? localDate(event.starts_at) : undefined} /></label><label>Ends (local time)<input type="datetime-local" name="ends_at" required defaultValue={event ? localDate(event.ends_at) : undefined} /></label></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? "Saving…" : event ? "Save changes" : "Create event"}<Icon name="arrow" size={17} /></button></form>;
}

function ProfileForm({ me, busy, save }: { me: Member; busy: boolean; save: (body: Record<string, string>) => Promise<unknown> }) {
  return <section className="profile-layout"><div className="panel profile-card"><span className="large-avatar">{me.name.slice(0, 1).toUpperCase()}</span><h2>{me.name}</h2><p>{me.email}</p><span className="badge">{me.role}</span><hr /><p>Be yourself. Share what you’re curious about and find common ground.</p></div><form className="panel stack-form profile-form" onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); save({ name: String(data.get("name")).trim(), bio: String(data.get("bio")).trim(), interests: String(data.get("interests")).trim() }); }}><div><h2>Your profile</h2><p className="form-intro">A little about the person behind the ideas.</p></div><label>Full name<input name="name" required maxLength={200} defaultValue={me.name} /></label><label>Email<input value={me.email} readOnly /><small>Your email is managed by your Microsoft account.</small></label><label>Bio<textarea name="bio" rows={4} maxLength={2000} defaultValue={me.bio || ""} placeholder="Tell the community a little about you…" /></label><label>Interests<input name="interests" maxLength={1000} defaultValue={me.interests || ""} placeholder="e.g. Machine learning, responsible AI, robotics" /></label><button className="button primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}<Icon name="arrow" size={17} /></button></form></section>;
}

function CheckinForm({ busy, submit }: { busy: boolean; submit: (token: string) => Promise<unknown> }) {
  const [token, setToken] = useState("");
  return <form className="panel stack-form checkin-form" onSubmit={async e => { e.preventDefault(); if (await submit(token.trim())) setToken(""); }}><span className="empty-icon"><Icon name="scan" size={30} /></span><h2>A warm welcome starts here</h2><p className="form-intro">Use an external QR scanner to read the member’s check-in code, then paste the raw token below. This form does not access your camera.</p><label>Scanned check-in token<textarea name="token" rows={4} required value={token} onChange={e => setToken(e.target.value)} placeholder="Paste the token from the member’s QR code" autoComplete="off" spellCheck={false} /></label><button className="button primary" disabled={busy || !token.trim()}>{busy ? "Checking in…" : "Record attendance"}<Icon name="arrow" size={17} /></button></form>;
}

function QrCode({ registration, request }: { registration: Registration; request: (path: string) => Promise<Response> }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true; let objectUrl = "";
    request(`/api/registrations/${registration.id}/qr`).then(r => r.blob()).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [registration.id, request]);
  return <div className="qr-content"><span className="badge">{registration.kind}</span><h3>{registration.title}</h3><p>{date(registration.starts_at)} · {time(registration.starts_at)}</p>{error ? <p className="form-error" role="alert">{error}</p> : url ? <img src={url} alt={`Personal check-in QR code for ${registration.title}`} width={250} height={250} /> : <p role="status">Loading your secure QR code…</p>}<p>Show this code to an officer at the event. Late check-in is available for up to two hours after the event ends. Keep this code private: it identifies your registration.</p></div>;
}

function ReportTable({ title, rows }: { title: string; rows: { label: string; registrations: number; attendance: number }[] }) {
  return <section className="panel report-panel"><h2>{title}</h2>{rows.length === 0 ? <p>No participation data yet.</p> : <div className="table-scroll"><table><caption className="sr-only">{title}</caption><thead><tr><th scope="col">{title.replace("By ", "")}</th><th scope="col">Registrations</th><th scope="col">Attendance</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><th scope="row">{row.label}</th><td>{row.registrations}</td><td>{row.attendance}</td></tr>)}</tbody></table></div>}</section>;
}
