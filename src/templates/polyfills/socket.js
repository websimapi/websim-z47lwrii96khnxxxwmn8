export const websimSocketPolyfill = `
// [WebSim] Realtime & DB Polyfill for Devvit
(function() {
    // Shared user state
    window._currentUser = null;

    // Helper: Sanitize Avatar URLs (Fix CSP & Loader Hangs)
    function sanitizeAvatar(url, username) {
        if (!url) return 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png';
        // If it's a WebSim URL, rewrite to local proxy to avoid CSP blocks and 404s
        if (url.includes('images.websim.ai') || url.includes('images.websim.com')) {
            return '/api/proxy/avatar/' + (username || 'guest');
        }
        return url;
    }

    // ------------------------------------------------------------------------
    // 1. WebsimSocket (Realtime Multiplayer)
    // ------------------------------------------------------------------------
    class WebsimSocket {
        constructor() {
            this.presence = {};
            this.roomState = {};
            this.peers = {};
            this.clientId = 'user-' + Math.random().toString(36).substr(2, 9);
            this.listeners = {
                presence: new Set(),
                roomState: new Set(),
                updateRequest: new Set(),
                message: null
            };
            this.socket = null;
            this.subscription = null; // connectRealtime returns a disposable subscription, not a bidirectional channel
            this.isConnected = false;

            // Singleton logic
            if (window.websimSocketInstance) {
                return window.websimSocketInstance;
            }
            window.websimSocketInstance = this;
        }

        async initialize() {
            console.log("[WebSim] Initializing Realtime Socket...");
            try {
                console.log("[WebSim] Connecting to realtime channel 'global_room'...");
                const connectRealtime = window.connectRealtime;

                if (!connectRealtime) throw new Error("connectRealtime not available - verify polyfill header");

                // Devvit Web Client (WebView) connectRealtime only receives messages.
                // It does NOT return a channel with .send().
                this.subscription = await connectRealtime({
                    channel: 'global_room',
                    onMessage: (msg) => {
                        // console.log("[WebSim] Raw Socket Msg:", msg); 
                        this._handleMessage(msg);
                    },
                    onConnect: () => {
                        console.log("[WebSim] Realtime Connected. ClientID:", this.clientId);
                        this.isConnected = true;
                        this._announceJoin();
                    },
                    onDisconnect: () => {
                        console.log("[WebSim] Realtime Disconnected");
                        this.isConnected = false;
                    }
                });
                
                // If onConnect isn't triggered immediately or we need to assume connectivity for optimistic UI
                this.isConnected = true;
                
                // CRITICAL FIX: Wait for identity so room.peers is populated before initialize() resolves.
                // This prevents race conditions where games check room.peers immediately after init.
                await this._announceJoin();

            } catch (e) {
                console.warn("[WebSim] Realtime init failed:", e);
                // Fallback: Local loopback for single player testing
                this.clientId = 'local-player';
                this.peers[this.clientId] = {
                    username: 'Player',
                    avatarUrl: 'https://www.redditstatic.com/avatars/avatar_default_02_FF4500.png'
                };
                // Ensure we still try to announce locally
                this._announceJoin();
            }
        }

        // --- Public API ---

        async _sendToServer(payload) {
            // In Devvit Web, client cannot send directly. Must fetch to server, which broadcasts via realtime plugin.
            try {
                // console.log("[WebSim] Sending to Server:", payload.type);
                const res = await fetch('/api/realtime/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) console.error("[WebSim] RT Send Failed:", res.status);
            } catch(e) {
                console.error("[WebSim] RT Send Error:", e);
            }
        }

        updatePresence(data) {
            // 1. Update Local
            this.presence[this.clientId] = { ...this.presence[this.clientId], ...data };
            this._notifyPresence();

            // 2. Broadcast via Server
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_presence',
                    clientId: this.clientId,
                    user: window._currentUser,
                    payload: data
                });
            }
        }

        updateRoomState(data) {
            // 1. Update Local
            this.roomState = { ...this.roomState, ...data };
            this._notifyRoomState();

            // 2. Broadcast via Server
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_roomstate',
                    payload: data
                });
            }
        }

        requestPresenceUpdate(targetClientId, update) {
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_req_update',
                    targetId: targetClientId,
                    fromId: this.clientId,
                    payload: update
                });
            }
        }

        send(event) {
            // Ephemeral Events
            if (this.isConnected) {
                this._sendToServer({
                    type: '_ws_event',
                    clientId: this.clientId,
                    username: window._currentUser?.username || 'Guest',
                    data: event
                });
            }
        }

        // --- Subscriptions ---

        subscribePresence(cb) {
            this.listeners.presence.add(cb);
            // Immediate callback
            try { cb(this.presence); } catch(e){}
            return () => this.listeners.presence.delete(cb);
        }

        subscribeRoomState(cb) {
            this.listeners.roomState.add(cb);
            try { cb(this.roomState); } catch(e){}
            return () => this.listeners.roomState.delete(cb);
        }

        subscribePresenceUpdateRequests(cb) {
            this.listeners.updateRequest.add(cb);
            return () => this.listeners.updateRequest.delete(cb);
        }
        
        set onmessage(cb) {
            this.listeners.message = cb;
        }

        // --- Internal Handlers ---

        _handleMessage(msg) {
            // Devvit Realtime usually sends the JSON object directly in recent versions,
            // but sometimes it's wrapped in an event object { message: ... } or { data: ... }
            
            let data = msg;
            if (msg.message) data = msg.message;
            else if (msg.data && !msg.type) data = msg.data; // Careful not to unwrap our own { type, data } payload prematurely

            console.log("[WebSim] RT Recv:", JSON.stringify(data).substring(0, 100));

            const type = data.type;

            if (type === '_ws_presence') {
                const { clientId, payload: presenceData, user } = data;
                
                // Update Peers List
                if (user && !this.peers[clientId]) {
                    this.peers[clientId] = {
                        id: clientId,
                        username: user.username,
                        avatarUrl: sanitizeAvatar(user.avatar_url, user.username)
                    };
                }

                // Merge Presence
                this.presence[clientId] = { ...this.presence[clientId], ...data };
                this._notifyPresence();
            }
            else if (type === '_ws_roomstate') {
                this.roomState = { ...this.roomState, ...data.payload };
                this._notifyRoomState();
            }
            else if (type === '_ws_req_update') {
                if (data.targetId === this.clientId) {
                    this.listeners.updateRequest.forEach(cb => cb(data.payload, data.fromId));
                }
            }
            else if (type === '_ws_event') {
                if (this.listeners.message) {
                    // Reconstruct WebSim event shape
                    const evt = {
                        data: {
                            ...data.data,
                            clientId: data.clientId,
                            username: data.username
                        }
                    };
                    this.listeners.message(evt);
                }
            }
        }

        _notifyPresence() {
            this.listeners.presence.forEach(cb => cb(this.presence));
        }

        _notifyRoomState() {
            this.listeners.roomState.forEach(cb => cb(this.roomState));
        }

        async _announceJoin() {
            // Wait for identity
            let tries = 0;
            while (!window._currentUser && tries < 10) {
                await new Promise(r => setTimeout(r, 100));
                tries++;
            }
            
            const user = window._currentUser || { username: 'Guest', avatar_url: '' };
            this.peers[this.clientId] = {
                id: this.clientId,
                username: user.username,
                avatarUrl: user.avatar_url
            };

            this.updatePresence({ joined: true });
        }
        
        // Collection stub for mixed usage
        collection(name) {
             return window.GenericDB.getAdapter(name);
        }
        
        static updateIdentity(user) {
            // Ensure we store a safe URL in the shared state
            if (user) {
                if (user.avatar_url) {
                    user.avatar_url = sanitizeAvatar(user.avatar_url, user.username);
                }
                // Polyfill camelCase for consistency with some game ports
                if (user.avatar_url && !user.avatarUrl) {
                    user.avatarUrl = user.avatar_url;
                }
            }
            window._currentUser = user;
            const inst = window.websimSocketInstance;
            if (inst && inst.peers[inst.clientId]) {
                inst.peers[inst.clientId].username = user.username;
                inst.peers[inst.clientId].avatarUrl = user.avatar_url;
                inst.updatePresence({}); // Trigger broadcast with new info
            }
        }
    }

    // Expose Global Class
    window.WebsimSocket = WebsimSocket;

    // Auto-instantiate if needed (often games use new WebsimSocket())
    // But some games access window.party directly.
    // We'll create a lazy instance and start it.
    if (!window.party) {
         window.party = new WebsimSocket();
         // Start connection automatically
         window.party.initialize();
    }


    // ------------------------------------------------------------------------
    // 2. Generic DB (Persistent Storage)
    // ------------------------------------------------------------------------
    window._genericDB = {};
    window._listCache = {};
    window._subscribers = {};

    const DevvitBridge = {
        init: async () => {
            console.log("[Bridge] Initializing DB...");
            try {
                const data = await fetch('/api/init').then(r => r.json());
                if (data.dbData) {
                    window._genericDB = data.dbData;
                    window._currentUser = data.user;
                    
                    if (window.WebsimSocket) {
                        window.WebsimSocket.updateIdentity(data.user);
                    }
                    
                    // Dispatch Ready
                    window.dispatchEvent(new CustomEvent('GAMEDATA_READY', { detail: data.dbData }));
                }
            } catch (e) { console.warn("[Bridge] Init failed", e); }
        },
        notifySubscribers: (collection) => {
            delete window._listCache[collection];
            const list = Object.values(window._genericDB[collection] || {}).sort((a,b) => (b.created_at || 0) < (a.created_at || 0) ? -1 : 1);
            if (window._subscribers[collection]) {
                window._subscribers[collection].forEach(cb => cb(list));
            }
        }
    };

    window.GenericDB = {
        save: async (col, key, val) => {
            if (!window._genericDB[col]) window._genericDB[col] = {};
            window._genericDB[col][key] = val;
            DevvitBridge.notifySubscribers(col);
            fetch('/api/save', { method:'POST', body:JSON.stringify({collection:col, key, value:val})}).catch(console.error);
        },
        get: (col, key) => window._genericDB[col]?.[key],
        getList: (col) => Object.values(window._genericDB[col] || {}),
        delete: async (col, key) => {
            if (window._genericDB[col]) delete window._genericDB[col][key];
            DevvitBridge.notifySubscribers(col);
            fetch('/api/delete', { method:'POST', body:JSON.stringify({collection:col, key})}).catch(console.error);
        },
        subscribe: (col, cb) => {
            if (!window._subscribers[col]) window._subscribers[col] = [];
            window._subscribers[col].push(cb);
            cb(window.GenericDB.getList(col));
            return () => window._subscribers[col] = window._subscribers[col].filter(f => f !== cb);
        },
        getAdapter: (name) => ({
             getList: () => window.GenericDB.getList(name),
             create: (d) => {
                 const id = Math.random().toString(36).substr(2,10);
                 const r = { id, ...d, created_at: new Date().toISOString() };
                 if(window._currentUser) { r.username = window._currentUser.username; r.avatar_url = window._currentUser.avatar_url; }
                 window.GenericDB.save(name, id, r);
                 return Promise.resolve(r);
             },
             update: (id, d) => {
                 const curr = window.GenericDB.get(name, id) || {};
                 const r = { ...curr, ...d };
                 window.GenericDB.save(name, id, r);
                 return Promise.resolve(r);
             },
             delete: (id) => window.GenericDB.delete(name, id),
             subscribe: (cb) => window.GenericDB.subscribe(name, cb),
             filter: () => ({ subscribe:()=>{}, getList:()=>[] }) // simplified
        })
    };

    if (document.readyState === 'complete') setTimeout(DevvitBridge.init, 100);
    else window.addEventListener('load', () => setTimeout(DevvitBridge.init, 100));

})();
`;