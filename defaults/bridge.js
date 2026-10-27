// Injected into the Fluxer page over CDP. Finds Fluxer's stores in the rspack
// bundle by method names (module ids and mangled names change per build) and
// exposes a small API on window.__fluxerDeck. Never returns tokens or any
// stored account data: only ids and display names.
(() => {
  const VERSION = 10;
  if (window.__fluxerDeck && window.__fluxerDeck.v === VERSION) return window.__fluxerDeck;

  const GUILD_VOICE = 2;
  const GUILD_TEXT = 0;
  const GUILD_ANNOUNCEMENT = 5;
  let req;
  rspackChunkfluxer_app.push([[Symbol('deck')], {}, (r) => { req = r; }]);

  // Module sources are scanned lazily and remembered: the bundle has thousands
  // of modules and every lookup would otherwise stringify them again.
  const sources = new Map();
  const sourceOf = (id, factory) => {
    let src = sources.get(id);
    if (src === undefined) {
      try { src = factory.toString(); } catch { src = ''; }
      sources.set(id, src);
    }
    return src;
  };
  const hasAll = (v, methods) => !!v && (typeof v === 'object' || typeof v === 'function')
    && methods.every((m) => { try { return typeof v[m] === 'function'; } catch { return false; } });

  const cache = {};
  // Find the exported object that has all of the given methods. A cached hit is
  // re-checked, so a reloaded bundle is found again instead of used stale.
  const find = (name, methods) => {
    if (cache[name] && hasAll(cache[name], methods)) return cache[name];
    delete cache[name];
    for (const [id, factory] of Object.entries(req.m)) {
      if (!methods.every((m) => sourceOf(id, factory).includes(m))) continue;
      let mod;
      try { mod = req(id); } catch { continue; }
      for (const k of Object.keys(mod || {})) {
        let v;
        try { v = mod[k]; } catch { continue; }
        if (hasAll(v, methods)) return (cache[name] = v);
      }
    }
    throw new Error('fluxer store not found: ' + name);
  };
  const accounts = () => find('accounts', ['switchToAccount', 'getAccount']);
  const media = () => find('media', ['connectToVoiceChannel', 'disconnectFromVoiceChannel']);
  const engine = () => find('engine', ['setScreenShareEnabled', 'setCameraEnabled']);
  const voice = () => find('voice', ['toggleSelfMute', 'toggleSelfDeaf']);
  const guilds = () => find('guilds', ['getGuildIds', 'getGuild']);
  const users = () => find('users', ['getUser', 'getUsers', 'getCurrentUser']);
  const rels = () => find('rels', ['getRelationships', 'getRelationship', 'isBlocked']);
  const presence = () => find('presence', ['getStatus', 'getCustomStatus', 'isMobile']);
  const channels = () => find('channels', ['getGuildChannels', 'getPrivateChannels']);

  // The app's own authenticated HTTP client (same session, no tokens handled here).
  const httpClient = () => find('http', ['get', 'post', 'put', 'patch', 'delete']);
  // Throws a readable error for a failed request, whichever way the client
  // reports it (rejection or a not-ok response).
  const request = async (method, url, options) => {
    let r;
    try {
      r = await httpClient()[method](url, options);
    } catch (e) {
      const body = e && (e.body || (e.response && e.response.body));
      const msg = (body && body.message) || (e && e.message) || String(e);
      throw new Error(msg);
    }
    if (r && r.ok === false) {
      const msg = (r.body && r.body.message) || ('request failed (HTTP ' + r.status + ')');
      throw new Error(msg);
    }
    return r;
  };
  const displayName = (u) => (u && [u.global_name, u.globalName, u.username].find((v) => typeof v === 'string' && v.trim())) || null;
  const personOf = (u) => {
    let status = 'offline';
    try { status = presence().getStatus(u.id) || 'offline'; } catch { /* ignore */ }
    return { id: u.id, name: displayName(u) || u.id, username: u.username || null, status, avatar: avatarUrl(u) };
  };
  // <instance origin>/media/avatars/<userId>/<hash>.webp, like the app's own <img>s.
  const origin = () => String(accounts().currentAccountKey || '').split('/api')[0];
  const avatarUrl = (u) => {
    if (!u || !u.id || !u.avatar) return null;
    const hash = String(u.avatar).replace(/^a_/, '');
    return origin() + '/media/avatars/' + u.id + '/' + hash + '.webp?size=80';
  };
  const iconUrl = (g) => (g && g.id && g.icon
    ? origin() + '/media/icons/' + g.id + '/' + String(g.icon).replace(/^a_/, '') + '.webp?size=80'
    : null);
  const FRIEND = 1;
  const DM_GROUP = 3;
  const person = (id) => {
    let u = null;
    try { u = users().getUser(id); } catch { /* not cached */ }
    const name = u && [u.globalName, u.global_name, u.username].find((v) => typeof v === 'string' && v.trim());
    let status = 'offline';
    try { status = presence().getStatus(id) || 'offline'; } catch { /* ignore */ }
    return { id, name: name || id, status, avatar: avatarUrl(u) };
  };
  const social = () => {
    const c = channels();
    const dms = c.getPrivateChannels()
      .filter((ch) => Array.isArray(ch.recipientIds) && ch.recipientIds.length > 0)
      .map((ch) => {
        const recipients = ch.recipientIds.map(person);
        const name = ch.type === DM_GROUP && ch.name ? ch.name : recipients.map((r) => r.name).join(', ');
        return { id: ch.id, type: ch.type, name, recipients, lastMessageId: ch.lastMessageId || null };
      })
      .sort((a, b) => (b.lastMessageId || '0').length - (a.lastMessageId || '0').length || (b.lastMessageId || '0').localeCompare(a.lastMessageId || '0'));
    const friends = rels().getRelationships().filter((r) => r.type === FRIEND).map((r) => {
      const p = person(r.userId || r.id);
      return r.nickname ? { ...p, name: r.nickname } : p;
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { dms, friends };
  };

  const api = {
    v: VERSION,
    // Each part is read on its own: a store that changed in a Fluxer update
    // loses only its own part of the view, and the reason is reported.
    state() {
      const problems = [];
      const part = (name, fn, fallback) => {
        try { return fn(); } catch (e) { problems.push({ part: name, error: String((e && e.message) || e) }); return fallback; }
      };
      const guildList = part('servers', () => {
        const g = guilds();
        const c = channels();
        return g.getGuildIds().map((id) => {
          const guild = g.getGuild(id);
          const all = c.getGuildChannels(id).slice().sort((x, y) => (x.position || 0) - (y.position || 0));
          const categoryOf = (ch) => {
            const parent = ch.parentId && all.find((x) => x.id === ch.parentId);
            return parent ? parent.name : null;
          };
          const pick = (types) => all
            .filter((ch) => types.includes(ch.type))
            .map((ch) => ({ id: ch.id, name: ch.name, category: categoryOf(ch) }));
          return {
            id,
            name: guild && guild.name,
            icon: iconUrl(guild),
            textChannels: pick([GUILD_TEXT, GUILD_ANNOUNCEMENT]),
            voiceChannels: pick([GUILD_VOICE]),
          };
        }).filter((x) => x.voiceChannels.length > 0 || x.textChannels.length > 0);
      }, []);
      const voiceState = part('voice', () => {
        const m = media();
        const v = voice();
        let channelName = null;
        if (m.channelId) {
          const ch = channels().getChannel(m.channelId);
          channelName = ch && ch.name;
        }
        return {
          channelId: m.channelId || null,
          channelName,
          connected: !!m.connected,
          connecting: !!m.connecting,
          selfMute: !!v.getSelfMute(),
          selfDeaf: !!v.getSelfDeaf(),
          streaming: !!window.__fluxerDeckStream,
        };
      }, { channelId: null, channelName: null, connected: false, connecting: false, selfMute: false, selfDeaf: false, streaming: false });
      const social_ = part('people', social, { dms: [], friends: [] });
      return {
        currentAccountKey: part('account', () => accounts().currentAccountKey, null),
        voice: voiceState,
        guilds: guildList,
        ...social_,
        problems,
        fluxerVersion: (/Fluxer\/([\d.]+)/.exec(navigator.userAgent) || [])[1] || null,
      };
    },
    // Which features this Fluxer build still supports, for the settings page.
    capabilities() {
      const check = (name, fn) => { try { fn(); return { name, ok: true }; } catch (e) { return { name, ok: false, error: String((e && e.message) || e) }; } };
      return [
        check('Accounts', accounts),
        check('Voice calls', media),
        check('Mute and deafen', voice),
        check('Screen share', engine),
        check('Servers', guilds),
        check('Channels', channels),
        check('People', users),
        check('Friends', rels),
        check('Status', presence),
        check('Messages and requests', httpClient),
      ];
    },
    async friends() {
      const r = await request('get', '/users/@me/relationships');
      const list = Array.isArray(r.body) ? r.body : [];
      const pick = (t) => list.filter((x) => x.type === t && x.user).map((x) => {
        const p = personOf(x.user);
        return x.nickname ? { ...p, name: x.nickname } : p;
      }).sort((a, b) => a.name.localeCompare(b.name));
      return { friends: pick(1), incoming: pick(3), outgoing: pick(4) };
    },
    async friendRequest(tag) {
      const [username, disc] = String(tag).trim().split('#');
      if (!username) throw new Error('Enter a name, for example name#0000');
      await request('post', '/users/@me/relationships', { body: { username, discriminator: disc || '0000' } });
    },
    async friendAccept(userId) { await request('put', '/users/@me/relationships/' + userId); },
    async friendRemove(userId) { await request('delete', '/users/@me/relationships/' + userId); },
    async openDm(userId) {
      const r = await request('post', '/users/@me/channels', { body: { recipient_id: userId } });
      return r.body && r.body.id;
    },
    async messages(channelId) {
      const r = await request('get', '/channels/' + channelId + '/messages', { query: { limit: 50 } });
      const me = users().getCurrentUser();
      return (Array.isArray(r.body) ? r.body : []).map((m) => ({
        id: m.id,
        author: displayName(m.author) || 'Unknown',
        authorId: m.author && m.author.id,
        avatar: avatarUrl(m.author),
        mine: !!(me && m.author && m.author.id === me.id),
        ts: m.timestamp,
        content: m.content || (m.attachments && m.attachments.length ? '[attachment]' : ''),
      })).reverse();
    },
    async send(channelId, content) {
      await request('post', '/channels/' + channelId + '/messages', { body: { content, nonce: String(Date.now()) } });
    },
    join(channelId) { media().connectToVoiceChannel(null, channelId); },
    leave() { return media().disconnectFromVoiceChannel('user'); },
    // Screen share. Fluxer asks for a screen with getDisplayMedia; under
    // gamescope that capture is black, so while sharing we answer that call with
    // our own track: H.264 frames from the plugin (gamescope's PipeWire stream)
    // decoded here. The share itself is still started and carried by Fluxer.
    async startStream(port, width, height, fps, publish = true) {
      if (window.__fluxerDeckStreamCtl) throw new Error('already sharing');
      if (typeof VideoDecoder === 'undefined') throw new Error('this Fluxer build cannot decode video');
      const ctl = { frames: 0, error: null, closed: false };
      const hasKey = (d) => {
        for (let i = 0; i + 3 < d.length; i++) {
          if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1 && ((d[i + 3] & 0x1f) === 5 || (d[i + 3] & 0x1f) === 7)) return true;
        }
        return false;
      };
      // A track generator needs no painting, so it keeps running while the
      // window is hidden (a canvas stream would stall).
      let track;
      let write;
      if (typeof MediaStreamTrackGenerator !== 'undefined') {
        const gen = new MediaStreamTrackGenerator({ kind: 'video' });
        const writer = gen.writable.getWriter();
        track = gen;
        write = (frame) => { writer.write(frame).catch(() => frame.close()); };
        ctl.closeTrack = () => { try { writer.close(); } catch { /* ignore */ } try { gen.stop(); } catch { /* ignore */ } };
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d');
        track = canvas.captureStream(fps).getVideoTracks()[0];
        write = (frame) => { g.drawImage(frame, 0, 0, width, height); frame.close(); };
        ctl.closeTrack = () => { try { track.stop(); } catch { /* ignore */ } };
      }
      const decoder = new VideoDecoder({
        output: (frame) => { ctl.frames += 1; write(frame); },
        error: (e) => { ctl.error = String(e && e.message || e); },
      });
      decoder.configure({ codec: 'avc1.42E034', optimizeForLatency: true });
      let gotKey = false;
      let ts = 0;
      const ws = new WebSocket('ws://127.0.0.1:' + port + '/stream');
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (m) => {
        const d = new Uint8Array(m.data);
        const key = hasKey(d);
        if (!gotKey && !key) return;
        gotKey = true;
        try {
          decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: d }));
          ts += Math.round(1e6 / fps);
        } catch (e) { ctl.error = String(e && e.message || e); }
      };
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('could not reach the stream link (blocked by the page?)'));
        setTimeout(() => reject(new Error('stream link timed out')), 5000);
      });
      const md = navigator.mediaDevices;
      const original = md.getDisplayMedia;
      Object.assign(ctl, { ws, decoder, md, original });
      window.__fluxerDeckStreamCtl = ctl;
      // publish=false decodes only (for tests): nothing is shared.
      if (!publish) return;
      md.getDisplayMedia = async () => new MediaStream([track]);
      try {
        await engine().setScreenShareEnabled(true);
      } catch (e) {
        await api.stopStream();
        throw e;
      }
      window.__fluxerDeckStream = true;
    },
    async stopStream() {
      const ctl = window.__fluxerDeckStreamCtl;
      window.__fluxerDeckStream = false;
      if (!ctl || ctl.original !== undefined) {
        try { await engine().setScreenShareEnabled(false); } catch { /* not sharing */ }
      }
      if (!ctl) return;
      window.__fluxerDeckStreamCtl = null;
      try { ctl.md.getDisplayMedia = ctl.original; } catch { /* ignore */ }
      try { ctl.ws.close(); } catch { /* ignore */ }
      try { ctl.decoder.close(); } catch { /* ignore */ }
      if (ctl.closeTrack) ctl.closeTrack();
    },
    // Frames decoded so far: tells "link works, screen is idle" from "no link".
    streamStats() {
      const c = window.__fluxerDeckStreamCtl;
      return c ? { frames: c.frames, error: c.error } : null;
    },
    toggleMute() { voice().toggleSelfMute(); },
    toggleDeafen() { voice().toggleSelfDeaf(); },
    switchAccount(accountKey) { return accounts().switchToAccount(accountKey); },
  };
  window.__fluxerDeck = api;
  return api;
})();
