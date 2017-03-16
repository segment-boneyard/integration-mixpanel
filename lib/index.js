'use strict';

/**
 * Module dependencies.
 */

var integration = require('segmentio-integration');
var parse = require('ua-parser-js');
var object = require('obj-case');
var time = require('unix-time');
var extend = require('extend');
var each = require('lodash/forEach');
var reject = require('reject');
var Batch = require('batch');
var tick = setImmediate;
var ms = require('ms');
var is = require('is');
var dates = require('convert-dates');
var pickBy = require('lodash/pickBy');

/**
 * Expose `Mixpanel`
 */

var Mixpanel = module.exports = integration('Mixpanel')
  .endpoint('https://api.mixpanel.com')
  .ensure('settings.token')
  .channels(['server'])
  .retries(2);

/**
 * Mixpanel requires an `.apiKey` on `track` and `screen`
 * if the message is older than 5 days. And
 * won't import anything older than 5 years.
 *
 * https://mixpanel.com/docs/api-documentation/importing-events-older-than-5-days
 * btw, we're not ensuring against this but it looks like if you send a date far into the future
 * Mixpanel will return an error but they do not have this documented anywhere so won't change ensure logic
 */

Mixpanel.ensure(function(msg, settings){
  var age = Date.now() - msg.timestamp();
  if (age > ms('5y')) {
    return this.invalid('message.timestamp() must be within the last five years.');
  }
  if (settings.apiKey) return;
  if (msg.type() !== 'track' && msg.type() !== 'screen') return;
  if (!shouldImport(msg)) return;
  return this.invalid('.apiKey is required if "track" or "screen" message is older than 5 days.');
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

  var ignoreTime = identify.proxy('context.Mixpanel.ignoreTime')
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

  var traits = formatTraits(identify);

  if (!this.settings.setAllTraitsByDefault) {
    var peopleProperties = (this.settings.peopleProperties || []).map(function(key) {
      return (object.find(traitAliases, key) || key).toLowerCase();
    });
    traits = pickBy(traits, function(value, key) {
      return peopleProperties.indexOf(key.toLowerCase()) !== -1;
    });
  }

  // $set must be a separate call than $union
  batch.push(function(fn){
    var payload = extend({ $set: traits }, basePayload);
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
  var consolidatedPageCalls = this.settings.consolidatedPageCalls;
  var trackAllPages = this.settings.trackAllPages;
  var trackCategorizedPages = this.settings.trackCategorizedPages;
  var trackNamedPages = this.settings.trackNamedPages;
  var category = msg.category();
  var name = msg.name();
  var fullName = msg.fullName(); // includes both category and name
  var self = this;

  // if they want to send all page/scren events with the default name from facade
  // i.e. "Loaded a Screen", "Loaded a Page"
  if (consolidatedPageCalls) return send(msg.track(), fn);

  // The old behavior
  // track all pages
  if (trackAllPages) return send(msg.track(), fn);

  // track categorized pages
  if (trackCategorizedPages && category){
    if (name) return send(msg.track(fullName), fn);
    return send(msg.track(category), fn);
  }

  // track named pages
  if (trackNamedPages && name) return send(msg.track(name), fn);

  // nothing
  return tick(fn);

  // call via track method with `msg`.
  function send(msg, done){
    self.track(msg, function(err, arr){
      if (err) return done(err);
      done(null, arr[1]);
    });
  }
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
    // Mixpanel doesn't send normal error objects with status codes so we have to manually parse their responses
    // for proper error handling by integration-workers
    if (!res.body.status) {
      var message = res.body.error;
      var newError = new Error(message);
      newError.status = message.match(/api_key/) ? 401 : 400;
      fn(newError);
    } else {
      fn(null, res);
    }
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
  lastSeen: '$last_seen', // This should be removed since docs say not to set this manually or can't be set
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
  var userAgent = identify.userAgent();

  // Delete any Segment trait names; they've now been renamed to Mixpanel names
  each(traitAliases, function(_, key) {
    object.del(traits, key, { normalizer: function(path) {
      return path.replace(/[^A-Za-z0-9\.$]+/g, '').toLowerCase();
    }});
  });

  if (userAgent) extend(traits, formatUserAgent(userAgent));

  // Format timestamp
  // https://mixpanel.com/help/reference/http#people-special-properties, `$created` section
  if (traits.$created) {
    traits.$created = formatDate(traits.$created);
  }

  // Map semantic mobile context properties
  extend(traits, formatMobileSpecific(identify));

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
  var campaign = track.proxy('context.campaign') || undefined;
  var app = track.proxy('context.app') || {};
  var semanticProps = {
    $app_release: app.build,
    $app_version: app.version,
    $current_url: track.proxy('context.page.url'),
    $device: track.proxy('context.device.name'),
    distinct_id: track.userId() || track.sessionId(),
    ip: track.ip(),
    mp_lib: 'Segment: ' + track.library().name,
    $referrer: track.referrer(),
    $search_engine: track.proxy('properties.searchEngine'),
    time: time(track.timestamp()),
    token: settings.token,
    $username: track.proxy('properties.username')
  };

  // Remove possible duplicate properties.
  // Note that this will object.del will strip any special characters
  // before the lookup
  object.del(properties, 'username');
  object.del(properties, 'searchEngine');
  object.del(properties, 'referrer');

  extend(properties, semanticProps);

  // Add the name tag
  properties.mp_name_tag = identify.name()
    || identify.email()
    || identify.userId()
    || identify.sessionId();

  if (userAgent) extend(properties, formatUserAgent(userAgent));

  // Map mobile specific special props
  extend(properties, formatMobileSpecific(track));

  // Map UTM params
  if (campaign) {
    properties.utm_source = campaign.source;
    properties.utm_medium = campaign.medium;
    properties.utm_term = campaign.term;
    properties.utm_content = campaign.content;
    properties.utm_campaign = campaign.name;
  }

  // Strip null/undefined values
  properties = reject(properties);
  stringifyValues(properties);

  return properties;
}

/**
 * Format userAgent properties
 *
 * https://mixpanel.com/help/questions/articles/what-properties-do-mixpanels-libraries-store-by-default
 *
 * @param {string} data
 * @return {Object}
 * @api private
 */

function formatUserAgent(data){
  var ret = {};
  var parsed = parse(data);
  var browser = parsed.browser;
  var os = parsed.os;

  if (browser) {
    ret.$browser = browser.name;
    if (browser.version) {
      var match = browser.version.match(/^(\d+(\.\d+)?)/);
      if (match) {
        ret.$browser_version = parseFloat(match[1]);
      } else {
        ret.$browser_version = browser.version;
      }
    }
  }

  if (os) {
    ret.$os = os.name;
    ret.$os_version = os.version;
  }

  return ret;
}

/**
 * Format mobile specific properties
 * https://mixpanel.com/help/questions/articles/what-properties-do-mixpanels-libraries-store-by-default
 *
 * @param {msg} msg
 * @return {Object}
 * @api private
 */

function formatMobileSpecific(track) {
  var device = track.proxy('context.device') || {};
  var app = track.proxy('context.app') || {};
  var os = track.proxy('context.os') || {};
  var network = track.proxy('context.network') || {};
  var screen = track.proxy('context.screen') || {};
  var ret = {};

  ret.$carrier = network.carrier;
  ret.$manufacturer = device.manufacturer;
  ret.$model = device.model;
  ret.$os = os.name;
  ret.$os_version = os.version;
  ret.$screen_height = screen.height;
  ret.$screen_width = screen.width;
  ret.$wifi = network.wifi
  // ret.$brand = device.model; what should this be


  switch (device.type) {
    case 'iOS':
      ret.$ios_ifa = device.advertisingId;
      ret.$ios_device_model = device.model;
      ret.$ios_app_release = app.build;
      ret.$ios_app_version = app.version;
      ret.$ios_version = os.version;
      break;
    case 'android':
      ret.$screen_dpi = screen.density;
      ret.$bluetooth_enabled = network.bluetooth;
      ret.$has_telephone = network.cellular;
      ret.$android_version_code = app.version;
      ret.$android_app_version = app.version;
      ret.$android_os = os.name;
      ret.$android_os_version = os.version;
      ret.$android_model = device.model;
      ret.$android_manufacturer = device.manufacturer;
      // ret.$android_brand = device.manufacturer; ?? what should this be
      break;
  }
  return ret;
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
  var ret = {
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
  // don't flag as last seen by default
  var ignoreTime = !track.active();
  if (ignoreTime) ret.$ignore_time = ignoreTime;
  return ret;
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
