/**
 * Event Bus
 *
 * Central event emitter for real-time game events.
 * SSE clients subscribe here. Games emit here.
 */

const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // SSE clients
    this.recentEvents = []; // Ring buffer for late joiners
    this.maxRecent = 50;
  }

  emit(event, data) {
    const entry = {
      event,
      data,
      timestamp: Date.now(),
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };

    this.recentEvents.push(entry);
    if (this.recentEvents.length > this.maxRecent) {
      this.recentEvents.shift();
    }

    return super.emit(event, entry);
  }

  getRecent(limit = 20) {
    return this.recentEvents.slice(-limit);
  }
}

// Singleton
module.exports = new EventBus();
