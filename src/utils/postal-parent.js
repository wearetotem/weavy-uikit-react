import { isPlainObject, eqObjects, S4 } from './utils';
import WeavyPromise from './promise';

//console.debug("postal.js", self.name);

function WeavyPostal(options) {

    var weavyPostal = this;

    this.timeout = options && options.timeout || 2000;

    var inQueue = [];
    var messageListeners = [];
    var contentWindows = new Set();
    var contentWindowsByWeavyId = new Map();
    var contentWindowOrigins = new WeakMap();
    var contentWindowNames = new WeakMap();
    var contentWindowWeavyIds = new WeakMap();
    var contentWindowDomain = new WeakMap();

    var _whenLeader = new WeavyPromise();
    var _isLeader = null;

    var _origin = extractOrigin(window.location.href);

    function extractOrigin(url) {
        var extractOrigin = null;
        try {
            extractOrigin = /^((?:https?:\/\/[^/]+)|(?:file:\/\/))\/?/.exec(url)[1]
        } catch (e) {
            console.error("Unable to resolve location origin. Make sure you are using http, https or file protocol and have a valid location URL.");
        }
        return extractOrigin;
    }

    function distributeMessage(e, fromFrame) {
        var fromSelf = e.source === window && e.origin === _origin;
        fromFrame ||= contentWindowOrigins.has(e.source) && e.origin === contentWindowOrigins.get(e.source);

        if (fromSelf || fromFrame) {

            var genericDistribution = !e.data.weavyId || e.data.weavyId === true;

            if (fromFrame && !e.data.windowName) {
                e.data.windowName = contentWindowNames.get(e.source);
            }

            var messageName = e.data.name;
            if (messageName === "distribute") {
                if (_isLeader) {
                    return;
                }
                e.data.name = e.data.distributeName;
            }

            //console.debug("message from", fromSelf && "self" || fromParent && "parent" || fromFrame && "frame " + e.data.windowName, e.data.name);

            messageListeners.forEach(function (listener) {
                var matchingName = listener.name === messageName || listener.name === "message";
                var genericListener = listener.selector === null;
                var matchingWeavyId = listener.selector === e.data.weavyId;
                var matchingDataSelector = isPlainObject(listener.selector) && eqObjects(listener.selector, e.data, true);

                if (matchingName && (genericDistribution || genericListener || matchingWeavyId || matchingDataSelector)) {

                    listener.handler(e, e.data);

                    if (listener.once) {
                        off(listener.name, listener.selector, listener.handler);
                    }
                }
            });
        }
    }

    window.addEventListener("message", function (e) {
        if (e.data.name && e.data.weavyId !== undefined) {
            if (e.data.weavyMessageId && e.data.name !== "message-receipt" && e.data.name !== "unready") {
                console.debug("sending message receipt", e.data.weavyMessageId, e.data.name)
                try {
                    e.source.postMessage({ name: "message-receipt", weavyId: e.data.weavyId, weavyMessageId: e.data.weavyMessageId }, e.origin);
                } catch (error) {
                    console.error("could not post back message-receipt to source");
                }
            }

            switch (e.data.name) {
                case "register-child":
                    if (!contentWindowWeavyIds.has(e.source)) {
                        console.warn("register-child: contentwindow not pre-registered");
                    }

                    if (contentWindowOrigins.get(e.source) !== e.origin) {
                        console.error("register-child: " + contentWindowNames.get(e.source) + " has invalid origin", e.origin);
                        return;
                    }

                    try {
                        var weavyId = contentWindowWeavyIds.get(e.source);
                        var contentWindowName = contentWindowNames.get(e.source);

                        if (contentWindowName) {
                            e.source.postMessage({
                                name: "register-window",
                                windowName: contentWindowName,
                                weavyId: weavyId || true,
                            }, e.origin);
                        }
                    } catch (e) {
                        console.error("could not register frame window", weavyId, contentWindowName, e);
                    }
                    break;
                case "ready":
                    if (contentWindowsByWeavyId.has(e.data.weavyId) && contentWindowNames.has(e.source) && contentWindowsByWeavyId.get(e.data.weavyId).get(contentWindowNames.get(e.source))) {
                        contentWindowDomain.set(e.source, e.origin);
                        distributeMessage(e);
                    }

                    break;
                case "unready":
                    // Source window does no longer exist at this point
                    if (contentWindowsByWeavyId.has(e.data.weavyId)) {
                        distributeMessage(e, true);
                    }

                    break;
                default:
                    if (e.source === window || contentWindowsByWeavyId.size) {
                        distributeMessage(e);
                    } else {
                        inQueue.push(e);
                    }

                    break;
            }
        }
    });

    function on(name, selector, handler) {
        if (typeof arguments[1] === "function") {
            // omit weavyId argument
            handler = arguments[1];
            selector = null;
        }
        messageListeners.push({ name: name, handler: handler, selector: selector });
    }

    function one(name, selector, handler) {
        if (typeof arguments[1] === "function") {
            // omit weavyId argument
            handler = arguments[1];
            selector = null;
        }
        messageListeners.push({ name: name, handler: handler, selector: selector, once: true });
    }

    function off(name, selector, handler) {
        if (typeof arguments[1] === "function") {
            // omit weavyId argument
            handler = arguments[1];
            selector = null;
        }
        messageListeners = messageListeners.filter(function (listener) {
            var nameMatch = name === listener.name;
            var handlerMatch = handler === listener.handler;
            var stringSelectorMatch = typeof selector === "string" && selector === listener.selector;
            var plainObjectMatch = isPlainObject(selector) && eqObjects(selector, listener.selector);
            var offMatch = nameMatch && handlerMatch && (selector === null || stringSelectorMatch || plainObjectMatch);
            return !(offMatch);
        });
    }

    /**
     * Sends the id of a frame to the frame content scripts, so that the frame gets aware of which id it has.
     * The frame needs to have a unique name attribute.
     *
     * @category panels
     * @param {string} weavyId - The id of the group or entity which the contentWindow belongs to.
     * @param {Window} contentWindow - The frame window to send the data to.
     */
    function registerContentWindow(contentWindow, contentWindowName, weavyId, contentOrigin) {
        try {
            if (!contentWindowName) {
                console.error("registerContentWindow() No valid contentWindow to register, must be a window and have a name.");
                return;
            }
        } catch (e) {
            console.error("registerContentWindow() cannot access contentWindowName")
        }

        if (contentWindow.self) {
            contentWindow = contentWindow.self;
        }

        if (!weavyId || weavyId === "true") {
            weavyId = true;
        }

        if (!contentWindowsByWeavyId.has(weavyId)) {
            contentWindowsByWeavyId.set(weavyId, new Map());
        }

        contentWindowsByWeavyId.get(weavyId).set(contentWindowName, contentWindow);
        contentWindows.add(contentWindow);
        contentWindowNames.set(contentWindow, contentWindowName);
        contentWindowWeavyIds.set(contentWindow, weavyId);
        contentWindowOrigins.set(contentWindow, contentOrigin);
    }

    function unregisterWeavyId(weavyId) {
        if (contentWindowsByWeavyId.has(weavyId)) {
            contentWindowsByWeavyId.get(weavyId).forEach(function (contentWindow, contentWindowName) {
                unregisterContentWindow(contentWindowName, weavyId);
            });
            contentWindowsByWeavyId.get(weavyId)
            contentWindowsByWeavyId.delete(weavyId);
        }
    }

    function unregisterContentWindow(windowName, weavyId) {
        if (contentWindowsByWeavyId.has(weavyId)) {
            if (contentWindowsByWeavyId.get(weavyId).has(windowName)) {
                var contentWindow = contentWindowsByWeavyId.get(weavyId).get(windowName);
                try {
                    contentWindows.delete(contentWindow);
                    contentWindowNames.delete(contentWindow);
                    contentWindowWeavyIds.delete(contentWindow);
                    contentWindowOrigins.delete(contentWindow);
                } catch (e) { /* no need to delete contentwindow */ }
            }
            contentWindowsByWeavyId.get(weavyId).delete(windowName);
            if (contentWindowsByWeavyId.get(weavyId).size === 0) {
                try {
                    contentWindowsByWeavyId.delete(weavyId);
                } catch (e) { /* no need to delete weavyId */ }
            }
        }
    }

    function whenPostMessage(contentWindow, message, transfer) {
        var whenReceipt = new WeavyPromise();

        if (transfer === null) {
            // Chrome does not allow transfer to be null
            transfer = undefined;
        }

        var toSelf = contentWindow === window.self;
        var origin = toSelf ? extractOrigin(window.location.href) : contentWindowOrigins.get(contentWindow);
        var validWindow = toSelf || contentWindow && origin === contentWindowDomain.get(contentWindow)

        if (validWindow) {
            if (!message.weavyMessageId) {
                message.weavyMessageId = S4() + S4();
            }

            queueMicrotask(() => {
                console.debug("whenPostMessage", message.name, message.weavyMessageId);

                var messageWatchdog = setTimeout(function () {
                    if (whenReceipt.state() === "pending") {
                        whenReceipt.reject(new Error("postMessage() receipt timed out: " + message.weavyMessageId + ", " + message.name));
                    }
                }, weavyPostal.timeout || 2000);

                on("message-receipt", { weavyId: message.weavyId, weavyMessageId: message.weavyMessageId }, function () {
                    console.debug("message-receipt received", message.weavyMessageId, message.name);
                    clearTimeout(messageWatchdog);
                    whenReceipt.resolve();
                });

                try {
                    contentWindow.postMessage(message, origin, transfer);
                } catch (e) {
                    whenReceipt.reject(e);
                }
            })
        } else {
            whenReceipt.reject(new Error("postMessage() Invalid window origin: " + origin + ", " + message.name));
        }

        return whenReceipt();
    }

    function postToChildren(message, transfer) {
        if (typeof message !== "object" || !message.name) {
            console.error("postToChildren() Invalid message format", message);
            return;
        }

        if (transfer === null) {
            // Chrome does not allow transfer to be null
            transfer = undefined;
        }

        message.distributeName = message.name;
        message.name = "distribute";
        message.weavyId = message.weavyId || true;

        contentWindows.forEach(function (contentWindow) {
            if (contentWindowOrigins.get(contentWindow) === contentWindowDomain.get(contentWindow)) {
                try {
                    contentWindow.postMessage(message, contentWindowOrigins.get(contentWindow), transfer);
                } catch (e) {
                    console.warn("postToChildren() could not distribute message to " + contentWindowNames.get(contentWindow))
                }
            }
        })

    }

    function postToFrame(windowName, weavyId, message, transfer) {
        if (typeof message !== "object" || !message.name) {
            console.error("postToFrame() Invalid message format", message);
            return;
        }

        var contentWindow;
        try {
            contentWindow = contentWindowsByWeavyId.get(weavyId).get(windowName);
        } catch (e) {
            console.error("postToFrame() Window not registered", weavyId, windowName);
        }

        message.weavyId = weavyId;

        return whenPostMessage(contentWindow, message, transfer);
    }

    function postToSelf(message, transfer) {
        if (typeof message !== "object" || !message.name) {
            console.error("postToSelf() Invalid message format", message);
            return;
        }

        message.weavyId = message.weavyId || true;

        return whenPostMessage(window.self, message, transfer);
    }

    function postToSource(e, message, transfer) {
        if (e.source && e.data.weavyId !== undefined) {
            var fromSelf = e.source === window.self && e.origin === _origin;
            var fromFrame = contentWindowOrigins.has(e.source) && e.origin === contentWindowOrigins.get(e.source);

            if (transfer === null) {
                // Chrome does not allow transfer to be null
                transfer = undefined;
            }

            if (fromSelf || fromFrame) {
                message.weavyId = e.data.weavyId;

                try {
                    e.source.postMessage(message, e.origin, transfer);
                } catch (e) {
                    console.error("postToSource() Could not post message back to source");
                }
            }
        }
    }

    function setLeader() {
        if (_whenLeader.state() === "pending") {
            //console.debug("Is leader");
            _isLeader = true;
            _whenLeader.resolve(_isLeader);
        }
    }

    function init() {
            setLeader();
    }

    this.on = on;
    this.one = one;
    this.off = off;
    this.registerContentWindow = registerContentWindow;
    this.unregisterContentWindow = unregisterContentWindow;
    this.unregisterAll = unregisterWeavyId;
    this.postToFrame = postToFrame;
    this.postToSelf = postToSelf;
    this.postToSource = postToSource;
    this.postToChildren = postToChildren;
    this.whenLeader = function () { return _whenLeader(); };

    Object.defineProperty(this, "isLeader", {
        get: function () { return _isLeader; }
    });

    init();
}


export default new WeavyPostal();



