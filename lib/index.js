'use strict';

/**
 * Module dependencies.
 */

var integration = require('segmentio-integration');
var parse = require('ua-parser-js');
var object = require('obj-case');
var time = require('unix-time');
var extend = require('extend');
var each = require('lodash.foreach');
var reject = require('reject');
var Batch = require('batch');
var tick = setImmediate;
var ms = require('ms');
var is = require('is');
var dates = require('convert-dates');

/**
 * Expose `Mixpanel`
 */

var Mixpanel = module.exports = integration('Mixpanel')
  .endpoint('https://api.mixpanel.com')
  .ensure('settings.token')
  .channels(['server'])
  .retries(2);

/**
 * Mixpanel requires an `.apiKey` on `track`
 * if the message is older than 5 days.
 */

Mixpanel.ensure(function(msg, settings){
  if (settings.apiKey) return;
  if ('track' != msg.type()) return;
  if (!shouldImport(msg)) return;
  return this.invalid('.apiKey is required if "track" message is older than 5 days.');
});

/**
 * Identify the Mixpanel user.
 *
 * https://mixpanel.com/help/reference/http#people-analytics-updates
 *
 * @param {Identify} identify
 * @param {Function} fn
 * @api public
 */

Mixpanel.prototype.identify = function(identify, fn){
  if (!this.settings.people) return tick(fn);

  var batch = new Batch;
  batch.throws(true)
  var self = this;

  var ignoreIp = identify.proxy('context.ignoreIp')  // TODO: remove
    || identify.proxy('context.Mixpanel.ignoreIp');

  var ignoreTime = identify.proxy('context.ignoreTime') // TODO: remove
    || identify.proxy('context.Mixpanel.ignoreTime')
    || !identify.active();

  // Default querystring and payload data shared across all calls
  var basePayload = {
    $distinct_id: identify.userId() || identify.sessionId(), // the primary id
    $token: this.settings.token,
    $time: identify.timestamp().getTime(),
    $ip: ignoreIp ? 0 : identify.ip() || 0, // use the ip passed in
    $ignore_time: ignoreTime,
    mp_lib: 'Segment: ' + identify.library().name
  };
  var baseQuery = {
    ip: 0,            // pass a flag to ignore the server-ip
    verbose: 1        // make sure that we get a valid response
  };

  // $set must be a separate call than $union
  batch.push(function(fn){
    var payload = extend({ $set: formatTraits(identify) }, basePayload);
    var query = extend({ data: b64encode(payload) }, baseQuery);

    self
      .get('/engage')
      .query(query)
      .end(self._parseResponse(fn));
  });

  // https://mixpanel.com/help/reference/ios-push-notifications
  // Send device token for iOS for push notification support
  var deviceToken = identify.proxy('context.device.token');
  if (deviceToken) {
    batch.push(function(fn){
      var payload = extend({
        $union: {
          $ios_devices: [deviceToken]
        }
      }, basePayload);
      var query = extend({ data: b64encode(payload) }, baseQuery);

      self
        .get('/engage')
        .query(query)
        .end(self._parseResponse(fn));
    });
  }

  batch.end(fn);

};

/**
 * Track a Mixpanel event
 *
 * https://mixpanel.com/help/reference/http#tracking-events
 *
 * TODO: update people's profile when increment is found.
 * see: https://mixpanel.com/help/reference/http#update-operations
 *
 * @param {Track} track
 * @param {Function} fn
 * @api public
 */

Mixpanel.prototype.track = function(track, fn){
  var imported = shouldImport(track)
  var endpoint = imported ? '/import' : '/track';
  var batch = new Batch;
  var self = this;
  var payload = {
    event: track.event(),
    properties: formatProperties(track, this.settings)
  };

  extend(payload.properties, superProperties(track, this.settings));

  var query = {
    verbose: 1,
    data: b64encode(payload),
    api_key: this.settings.apiKey
  };

  // increment
  if (this.settings.people) {
    batch.push(function(fn){
      self.increment(track, fn);
    });
  }

  batch.push(function(done){
    self
    .post(endpoint)
    .set('Content-Length', 0)
    .query(query)
    .end(self._parseResponse(done));
  });

  if (track.revenue()) {
    batch.push(function(done){
      self.revenue(track, done);
    });
  }

  batch.end(fn);
};

/**
 * Track Page / Screen using `msg`.
 *
 * TODO:
 *
 *    In the new Integration proto abstract this away,
 *    doing `if's` in each integration is annoying,
 *    we can automate this even for integrations
 *    that map to page -> track -- this will reduce errors.
 *
 * @param {Track|Screen} msg
 * @param {Function} fn
 */

Mixpanel.prototype.screen =
Mixpanel.prototype.page = function(msg, fn){
  var batch = new Batch;
  var category = msg.category();
  var name = msg.fullName();
  var self = this;

  // all
  if (this.settings.trackAllPages) {
    batch.push(track(msg.track()));
  }

  // categorized
  if (category && this.settings.trackCategorizedPages) {
    batch.push(track(msg.track(category)));
  }

  // named
  if (name && this.settings.trackNamedPages) {
    batch.push(track(msg.track(name)));
  }

  // call track with `msg`.
  function track(msg){
    return function(done){
      self.track(msg, function(err, arr){
        if (err) return done(err);
        done(null, arr[1]);
      });
    };
  }

  batch.end(fn);
};

/**
 * Alias a user from one id to the other
 *
 * https://mixpanel.com/help/reference/http#distinct-id-alias
 *
 * @param {Alias} alias
 * @param {Function} fn
 * @api public
 */

Mixpanel.prototype.alias = function(alias, fn){
  var previousId = alias.previousId();
  var userId = alias.userId();
  var payload = {
    event: '$create_alias',
    properties: {
      distinct_id: previousId,
      alias: userId,
      token: this.settings.token
    }
  };

  this
    .post('/track')
    .query({ ip: 0 })
    .query({ verbose: 1 })
    .query({ data: b64encode(payload) })
    .query({ api_key: this.settings.apiKey })
    .set('Content-Length', 0) // mixpanel rejects length-less requests
    .end(this._parseResponse(fn));
};

/**
 * Track a mixpanel revenue call
 *
 * https://mixpanel.com/help/reference/http#tracking-revenue
 *
 * @param {Track} track
 * @param {Function} callback
 * @api private
 */

Mixpanel.prototype.revenue = function(track, fn){
  var ignoreIp = track.proxy('options.ignoreIp');
  if (ignoreIp === undefined) ignoreIp = true;
  var req = this.get('/engage');
  if (ignoreIp) req.query({ ip: 0 });
  req
    .query({ verbose: 1 })
    .query({ data: b64encode(formatRevenue(track, this.settings)) })
    .end(this._parseResponse(fn));
};

/**
 * Increment the given `track` with `settings` and `callback`.
 *
 * Unfortunately Mixpanel doesn't let you specify 2 operations,
 * so we request twice, once for `$add` and once for `$set`.
 *
 * @param {Track} track
 * @param {Function} fn
 * @api private
 */

Mixpanel.prototype.increment = function(track, fn){
  var increments = getIncrements(track, this.settings);
  var batch = new Batch;
  var self = this;

  // ignore
  if (!increments) return tick(fn);
  if (!track.userId()) return tick(fn);

  // send
  batch.push(send('$add'));
  batch.push(send('$set'));
  batch.end(fn);

  // send `type`
  function send(type){
    return function(done){
      var payload = {};
      payload.$distinct_id = track.userId();
      payload.$token = self.settings.token;
      payload.mp_lib = 'Segment.io';
      payload[type] = increments[type];
      var b64 = b64encode(payload);

      return self
        .get('/engage')
        .query({ ip: 0 })
        .query({ verbose: 1 })
        .query({ data: b64 })
        .end(self._parseResponse(done));
    };
  }
};

/**
 * Common function for parsing the response from a mixpanel call.
 *
 * @param {Function} fn
 * @api private
 */

Mixpanel.prototype._parseResponse = function(fn){
  var self = this;
  return this.handle(function(err, res){
    if (err) return fn(err);
    if (!res.body.status) return fn(self.error(res.body.error));
    fn(null, res);
  });
};

/**
 * Add user super properties to the track.
 *
 * @param {Track} track
 * @return {Object}
 * @api private
 */

function superProperties(track, settings){
  var identify = track.identify();
  var traits = formatTraits(identify) || {};
  var properties = {};

  if (!is.object(traits)) return properties;

  Object.keys(traits).forEach(function(trait){
    var val = traits[trait];
    // an early version of the integrations prefixed traits incorrectly
    // the setting preserves backwards compat.
    if (settings.legacySuperProperties && trait.charAt(0) !== '$') {
      trait = '$' + trait;
    }
    properties[trait] = val;
  });

  return properties;
}

/**
 * A map of Segment traits to special Mixpanel user properties.
 *
 * https://mixpanel.com/help/reference/http#people-special-properties
 */

var traitAliases = {
  created: '$created',
  createdAt: '$created',
  email: '$email',
  firstName: '$first_name',
  lastName: '$last_name',
  lastSeen: '$last_seen',
  name: '$name',
  username: '$username',
  phone: '$phone',
  // Token is reserved by Mixpanel, so remap it.
  token: 'trait_token'
};

/**
 * Format the traits from the identify
 *
 * @param {Identify} identify
 * @return {Object}
 * @api private
 */

function formatTraits(identify){
  // Get traits, renaming any special Mixpanel properties from their Segment names
  var traits = identify.traits(traitAliases) || {};

  // Delete any Segment trait names; they've now been renamed to Mixpanel names
  each(traitAliases, function(_, key) {
    object.del(traits, key, { normalizer: function(path) {
      return path.replace(/[^A-Za-z0-9\.$]+/g, '').toLowerCase();
    }});
  });

  // Facade automatically converts `name` to `firstName` and `lastName`, so we don't need this
  delete traits.$name;
  // https://mixpanel.com/help/reference/http#people-special-properties, `$created` section
  if (traits.$created) {
    traits.$created = formatDate(traits.$created);
  }

  stringifyValues(traits);
  return traits;
}

/**
 * Format the mixpanel specific properties.
 *
 * https://github.com/mixpanel/mixpanel-android/blob/34eb2205882cae137597dfb16f9c13545de32ca5/src/main/java/com/mixpanel/android/mpmetrics/AnalyticsMessages.java#L403
 *
 * @param {Track} track
 * @param {Object} settings
 * @return {Object}
 */

function formatProperties(track, settings){
  var properties = track.properties() || {};
  var identify = track.identify();
  var userAgent = track.userAgent();
  extend(properties, {
    token: settings.token,
    distinct_id: track.userId() || track.sessionId(),
    time: time(track.timestamp()),
    mp_lib: 'Segment: ' + track.library().name,
    $lib_version: track.library().version,
    $search_engine: track.proxy('properties.searchEngine'),
    $referrer: track.referrer(),
    $username: track.username(),
    $os: track.proxy('context.os.name'),
    $os_version: track.proxy('context.os.version'),
    $manufacturer: track.proxy('context.device.manufacturer'),
    $screen_dpi: track.proxy('context.screen.density'),
    $screen_height: track.proxy('context.screen.height'),
    $screen_width: track.proxy('context.screen.width'),
    $bluetooth_enabled: track.proxy('context.network.bluetooth'),
    $has_telephone: track.proxy('context.network.cellular'),
    $carrier: track.proxy('context.network.carrier'),
    $app_version: track.proxy('context.app.version'),
    $wifi: track.proxy('context.network.wifi'),
    $brand: track.proxy('context.device.brand'),
    $model: track.proxy('context.device.model'),
    $app_release: track.proxy('context.app.build'),
    ip: track.ip()
  });

  // Remove possible duplicate properties.
  object.del(properties, 'referrer');
  object.del(properties, 'username');
  object.del(properties, 'searchEngine');

  // Add the name tag
  properties.mp_name_tag = identify.name()
    || identify.email()
    || identify.userId()
    || identify.sessionId();

  properties = reject(properties);
  stringifyValues(properties);

  if (userAgent) {
    var parsed = parse(userAgent);
    var browser = parsed.browser
    var os = parsed.os;
    if (browser) properties.$browser = browser.name;
    if (os) properties.$os = os.name;
  }
  return properties;
}

/**
 * Create a revenue track call
 *
 * https://mixpanel.com/help/reference/http#tracking-revenue
 *
 * @param {Track} track
 * @param {Object} settings
 * @return {Object}
 * @api private
 */

function formatRevenue(track, settings){
  return {
    $distinct_id: track.userId() || track.sessionId(),
    $token: settings.token,
    $ip: track.ip(),
    $append: {
      $transactions: {
        $time: formatDate(track.timestamp()),
        $amount: track.revenue()
      }
    }
  };
}

/**
 * Formats a date for Mixpanel's API, takes the first part of the iso string
 *
 * https://mixpanel.com/help/reference/http#dates-in-updates
 *
 * @param {Mixed} date
 * @return {String}
 * @api private
 */

function formatDate(date){
  date = new Date(date);
  if (isNaN(date.getTime())) return;
  return date.toISOString().slice(0,19);
}

/**
 * Get increments.
 *
 * @param {Track} track
 * @param {Object} settings
 * @return {Object}
 * @api private
 */

function getIncrements(track, settings){
  var inc = lowercase(settings.increments || []);
  var event = track.event();
  if (!~inc.indexOf(event.toLowerCase())) return;
  var ret = { $set: {}, $add: {} };
  ret.$set['Last ' + event] = formatDate(track.timestamp());
  ret.$add[event] = 1;
  return ret;
}

/**
 * Mixpanel uses different endpoints for historical import.
 *
 * https://mixpanel.com/docs/api-documentation/importing-events-older-than-31-days
 *
 * @param {Facade} message
 * @return {Boolean}
 * @api private
 */

function shouldImport(message){
  var timestamp = message.timestamp() || new Date();
  return (Date.now() - timestamp.getTime()) > ms('5d');
}

/**
 * Base64 encode the payload
 *
 * @param {Object} payload
 * @return {String}
 * @api private
 */

function b64encode(payload){
  return new Buffer(JSON.stringify(payload)).toString('base64');
}

/**
 * Stringify the nested values for an object.
 *
 * @param {Object} obj
 * @return {Object}
 * @api private
 */

function stringifyValues(obj){
  if (!is.object(obj)) return obj;

  Object.keys(obj).forEach(function(key){
    var val = obj[key];
    if (is.object(val)) obj[key] = JSON.stringify(val);
  });

  return obj;
}

/**
 * Lowercase the given `arr`.
 *
 * @param {Array} arr
 * @return {Array}
 * @api private
 */

function lowercase(arr){
  var ret = [];

  for (var i = 0; i < arr.length; ++i) {
    ret.push(String(arr[i]).toLowerCase());
  }

  return ret;
}
