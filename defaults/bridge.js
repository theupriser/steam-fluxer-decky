// Injected into the Fluxer page over CDP. Finds Fluxer's stores in the rspack
// bundle by method names (module ids and mangled names change per build) and
// exposes a small API on window.__fluxerDeck. Never returns tokens or any
// stored account data: only ids and display names.
(() => {
  const VERSION = 5;
  if (window.__fluxerDeck && window.__fluxerDeck.v === VERSION) return window.__fluxerDeck;

  const GUILD_VOICE = 2;
  let req;
  rspackChunkfluxer_app.push([[Symbol('deck')], {}, (r) => { req = r; }]);

  const cache = {};
  // Find the exported object that has all of the given methods.
  const find = (name, methods) => {
    if (cache[name]) return cache[name];
    for (const [id, factory] of Object.entries(req.m)) {
      const src = factory.toString();
      if (!methods.every((m) => src.includes(m))) continue;
      let mod;
      try { mod = req(id); } catch { continue; }
      for (const k of Object.keys(mod)) {
        let v;
        try { v = mod[k]; } catch { continue; }
        if (v && (typeof v === 'object' || typeof v === 'function') && methods.every((m) => typeof v[m] === 'function')) {
          return (cache[name] = v);
        }
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
  const http = () => find('http', ['get', 'post', 'put', 'patch', 'delete']);
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
    state() {
      const m = media();
      const v = voice();
      const g = guilds();
      const c = channels();
      const guildList = g.getGuildIds().map((id) => {
        const guild = g.getGuild(id);
        const voiceChannels = c
          .getGuildChannels(id)
          .filter((ch) => ch.type === GUILD_VOICE)
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .map((ch) => ({ id: ch.id, name: ch.name }));
        return { id, name: guild && guild.name, voiceChannels };
      }).filter((x) => x.voiceChannels.length > 0);
      let channelName = null;
      if (m.channelId) {
        const ch = c.getChannel(m.channelId);
        channelName = ch && ch.name;
      }
      return {
        currentAccountKey: accounts().currentAccountKey,
        voice: {
          channelId: m.channelId || null,
          channelName,
          connected: !!m.connected,
          connecting: !!m.connecting,
          selfMute: !!v.getSelfMute(),
          selfDeaf: !!v.getSelfDeaf(),
          streaming: !!window.__fluxerDeckStream,
        },
        guilds: guildList,
        ...social(),
      };
    },
    async friends() {
      const r = await http().get('/users/@me/relationships');
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
      await http().post('/users/@me/relationships', { body: { username, discriminator: disc || '0000' } });
    },
    async friendAccept(userId) { await http().put('/users/@me/relationships/' + userId); },
    async friendRemove(userId) { await http().delete('/users/@me/relationships/' + userId); },
    async openDm(userId) {
      const r = await http().post('/users/@me/channels', { body: { recipient_id: userId } });
      return r.body && r.body.id;
    },
    async messages(channelId) {
      const r = await http().get('/channels/' + channelId + '/messages', { query: { limit: 50 } });
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
      await http().post('/channels/' + channelId + '/messages', { body: { content, nonce: String(Date.now()) } });
    },
    join(channelId) { media().connectToVoiceChannel(null, channelId); },
    leave() { return media().disconnectFromVoiceChannel('user'); },
    // Screen share through the app's own voice engine. Which screen/window is
    // shared is decided by the app (Electron display capture).
    async toggleStream() {
      const next = !window.__fluxerDeckStream;
      await engine().setScreenShareEnabled(next);
      window.__fluxerDeckStream = next;
    },
    toggleMute() { voice().toggleSelfMute(); },
    toggleDeafen() { voice().toggleSelfDeaf(); },
    switchAccount(accountKey) { return accounts().switchToAccount(accountKey); },
  };
  window.__fluxerDeck = api;
  return api;
})();
