// Injected into the Fluxer page over CDP. Finds Fluxer's stores in the rspack
// bundle by method names (module ids and mangled names change per build) and
// exposes a small API on window.__fluxerDeck. Never returns tokens or any
// stored account data: only ids and display names.
(() => {
  const VERSION = 2;
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
  const voice = () => find('voice', ['toggleSelfMute', 'toggleSelfDeaf']);
  const guilds = () => find('guilds', ['getGuildIds', 'getGuild']);
  const users = () => find('users', ['getUser', 'getUsers', 'getCurrentUser']);
  const rels = () => find('rels', ['getRelationships', 'getRelationship', 'isBlocked']);
  const presence = () => find('presence', ['getStatus', 'getCustomStatus', 'isMobile']);
  const channels = () => find('channels', ['getGuildChannels', 'getPrivateChannels']);

  const FRIEND = 1;
  const DM_GROUP = 3;
  const person = (id) => {
    let u = null;
    try { u = users().getUser(id); } catch { /* not cached */ }
    const name = u && [u.globalName, u.global_name, u.username].find((v) => typeof v === 'string' && v.trim());
    let status = 'offline';
    try { status = presence().getStatus(id) || 'offline'; } catch { /* ignore */ }
    return { id, name: name || id, status };
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
        },
        guilds: guildList,
        ...social(),
      };
    },
    join(channelId) { media().connectToVoiceChannel(null, channelId); },
    leave() { return media().disconnectFromVoiceChannel('user'); },
    toggleMute() { voice().toggleSelfMute(); },
    toggleDeafen() { voice().toggleSelfDeaf(); },
    switchAccount(accountKey) { return accounts().switchToAccount(accountKey); },
  };
  window.__fluxerDeck = api;
  return api;
})();
