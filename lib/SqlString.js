// config values
var MYSQL_CONFIG = {
  ID_SIGN: '`',
  STRING_LITERAL_SIGN: "'",
  TABLE_NAME_SEPARATOR: '.',
  VALUE_PLACEHOLDER_GLOBAL_REGEX: /(?<!\?)\?(?!\?)/g, // default regex for placeholders is /\?+/g
  ID_PLACEHOLDER_GLOBAL_REGEX: /(?<!\?)\?\?(?!\?)/g,
  CHARS_GLOBAL_REGEXP: /[\0\b\t\n\r\x1a\"\'\\]/g, // eslint-disable-line no-control-regex
  CHARS_ESCAPE_MAP: {
    '\0'   : '\\0',
    '\b'   : '\\b',
    '\t'   : '\\t',
    '\n'   : '\\n',
    '\r'   : '\\r',
    '\x1a' : '\\Z',
    '"'    : '\\"',
    '\''   : '\\\'',
    '\\'   : '\\\\'
  },
  debug: false,
};

var POSTGRES_CONFIG = {
  ID_SIGN: '"',
  STRING_LITERAL_SIGN: "'",
  TABLE_NAME_SEPARATOR: '.',
  VALUE_PLACEHOLDER_GLOBAL_REGEX: /\$\d+/g,
  ID_PLACEHOLDER_GLOBAL_REGEX: /%I/g,
  CHARS_GLOBAL_REGEXP: /[\0\b\t\n\r\x1a\"\'\\]/g, // eslint-disable-line no-control-regex
  CHARS_ESCAPE_MAP: {
    '\0'   : '\\0',
    '\b'   : '\\b',
    '\t'   : '\\t',
    '\n'   : '\\n',
    '\r'   : '\\r',
    '\x1a' : '\\Z',
    '"'    : '\\"',
    '\''   : '\\\'',
    '\\'   : '\\\\'
  },
  debug: false,
};

var DEFAULT_CONFIG = MYSQL_CONFIG;

// exported methods are still the same
Object.assign(exports, withConfig(DEFAULT_CONFIG));

// config exported values
exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
exports.MYSQL_CONFIG = MYSQL_CONFIG;
exports.POSTGRES_CONFIG = POSTGRES_CONFIG;
exports.withConfig = withConfig;

function withConfig(customConfig = DEFAULT_CONFIG) {
  var CONFIG = Object.assign({}, DEFAULT_CONFIG, customConfig);

  var SqlString = {};

  // computed config values
  var ID_GLOBAL_REGEXP    = new RegExp(CONFIG.ID_SIGN, 'g');
  var QUAL_GLOBAL_REGEXP  = new RegExp('\\' + CONFIG.TABLE_NAME_SEPARATOR, 'g');
  var CHARS_ESCAPE_MAP    = CONFIG.CHARS_ESCAPE_MAP;

  SqlString.escapeId = function escapeId(val, forbidQualified) {
    var DOUBLE_ID_SIGN = CONFIG.ID_SIGN + CONFIG.ID_SIGN;

    if (Array.isArray(val)) {
      var sql = '';

      for (var i = 0; i < val.length; i++) {
        sql += (i === 0 ? '' : ', ') + SqlString.escapeId(val[i], forbidQualified);
      }

      return sql;
    } else if (forbidQualified) {
      return CONFIG.ID_SIGN + String(val).replace(ID_GLOBAL_REGEXP, DOUBLE_ID_SIGN) + CONFIG.ID_SIGN;
    } else {
      return CONFIG.ID_SIGN + String(val).replace(ID_GLOBAL_REGEXP, DOUBLE_ID_SIGN).replace(QUAL_GLOBAL_REGEXP, CONFIG.ID_SIGN + CONFIG.TABLE_NAME_SEPARATOR + CONFIG.ID_SIGN) + CONFIG.ID_SIGN;
    }
  };

  SqlString.escape = function escape(val, stringifyObjects, timeZone) {
    if (val === undefined || val === null) {
      return 'NULL';
    }

    switch (typeof val) {
      case 'boolean': return (val) ? 'true' : 'false';
      case 'number': return val + '';
      case 'object':
        if (Object.prototype.toString.call(val) === '[object Date]') {
          return SqlString.dateToString(val, timeZone || 'local');
        } else if (Array.isArray(val)) {
          return SqlString.arrayToList(val, timeZone);
        } else if (Buffer.isBuffer(val)) {
          return SqlString.bufferToString(val);
        } else if (typeof val.toSqlString === 'function') {
          return String(val.toSqlString());
        } else if (stringifyObjects) {
          return escapeString(val.toString());
        } else {
          return SqlString.objectToValues(val, timeZone);
        }
      default: return escapeString(val);
    }
  };

  SqlString.arrayToList = function arrayToList(array, timeZone) {
    var sql = '';

    for (var i = 0; i < array.length; i++) {
      var val = array[i];

      if (Array.isArray(val)) {
        sql += (i === 0 ? '' : ', ') + '(' + SqlString.arrayToList(val, timeZone) + ')';
      } else {
        sql += (i === 0 ? '' : ', ') + SqlString.escape(val, true, timeZone);
      }
    }

    return sql;
  };

  SqlString.format = function format(sql = '', values = [], stringifyObjects, timeZone) {
    // skip null, undefined
    if (values == null) {
      return sql;
    }

    if (!Array.isArray(values)) {
      values = [values];
    }

    var chunkIndex                = 0;
    var idPlaceholdersRegex       = copyRegExp(CONFIG.ID_PLACEHOLDER_GLOBAL_REGEX);
    var valuePlaceholdersRegex    = copyRegExp(CONFIG.VALUE_PLACEHOLDER_GLOBAL_REGEX);
    var result                    = '';
    var valuesIndex               = 0;
    var idMatch;
    var valueMatch;

    debug('\nstart', { sql, values });

    while (
      valuesIndex < values.length
      && (
        (idMatch = idPlaceholdersRegex.exec(sql)) || (valueMatch = valuePlaceholdersRegex.exec(sql))
      )
    ) {
      // id is prioritized over value
      var isIdMatch = !!idMatch;
      var match = isIdMatch ? idMatch : valueMatch;
      var regex = isIdMatch ? idPlaceholdersRegex : valuePlaceholdersRegex;

      var value = isIdMatch
        ? SqlString.escapeId(values[valuesIndex])
        : SqlString.escape(values[valuesIndex], stringifyObjects, timeZone);

      result += sql.slice(chunkIndex, match.index) + value;
      chunkIndex = regex.lastIndex;
      valuesIndex++;
    }

    debug('end', {
      sql,
      values,
      result,
      chunkIndex,
    });

    if (chunkIndex === 0) {
      // Nothing was replaced
      return sql;
    }

    if (chunkIndex < sql.length) {
      return result + sql.slice(chunkIndex);
    }

    return result;
  };

  SqlString.dateToString = function dateToString(date, timeZone) {
    var dt = new Date(date);

    if (isNaN(dt.getTime())) {
      return 'NULL';
    }

    var year;
    var month;
    var day;
    var hour;
    var minute;
    var second;
    var millisecond;

    if (timeZone === 'local') {
      year        = dt.getFullYear();
      month       = dt.getMonth() + 1;
      day         = dt.getDate();
      hour        = dt.getHours();
      minute      = dt.getMinutes();
      second      = dt.getSeconds();
      millisecond = dt.getMilliseconds();
    } else {
      var tz = convertTimezone(timeZone);

      if (tz !== false && tz !== 0) {
        dt.setTime(dt.getTime() + (tz * 60000));
      }

      year       = dt.getUTCFullYear();
      month       = dt.getUTCMonth() + 1;
      day         = dt.getUTCDate();
      hour        = dt.getUTCHours();
      minute      = dt.getUTCMinutes();
      second      = dt.getUTCSeconds();
      millisecond = dt.getUTCMilliseconds();
    }

    // YYYY-MM-DD HH:mm:ss.mmm
    var str = zeroPad(year, 4) + '-' + zeroPad(month, 2) + '-' + zeroPad(day, 2) + ' ' +
      zeroPad(hour, 2) + ':' + zeroPad(minute, 2) + ':' + zeroPad(second, 2) + '.' +
      zeroPad(millisecond, 3);

    return escapeString(str);
  };

  SqlString.bufferToString = function bufferToString(buffer) {
    return 'X' + escapeString(buffer.toString('hex'));
  };

  SqlString.objectToValues = function objectToValues(object, timeZone) {
    var sql = '';

    for (var key in object) {
      var val = object[key];

      if (typeof val === 'function') {
        continue;
      }

      sql += (sql.length === 0 ? '' : ', ') + SqlString.escapeId(key) + ' = ' + SqlString.escape(val, true, timeZone);
    }

    return sql;
  };

  SqlString.raw = function raw(sql) {
    if (typeof sql !== 'string') {
      throw new TypeError('argument sql must be a string');
    }

    return {
      toSqlString: function toSqlString() { return sql; }
    };
  };

  function escapeString(val) {
    var CHARS_GLOBAL_REGEXP = copyRegExp(CONFIG.CHARS_GLOBAL_REGEXP);

    var chunkIndex = CHARS_GLOBAL_REGEXP.lastIndex = 0;
    var escapedVal = '';
    var match;

    while ((match = CHARS_GLOBAL_REGEXP.exec(val))) {
      escapedVal += val.slice(chunkIndex, match.index) + CHARS_ESCAPE_MAP[match[0]];
      chunkIndex = CHARS_GLOBAL_REGEXP.lastIndex;
    }

    if (chunkIndex === 0) {
      // Nothing was escaped
      return CONFIG.STRING_LITERAL_SIGN + val + CONFIG.STRING_LITERAL_SIGN;
    }

    if (chunkIndex < val.length) {
      return CONFIG.STRING_LITERAL_SIGN + escapedVal + val.slice(chunkIndex) + CONFIG.STRING_LITERAL_SIGN;
    }

    return CONFIG.STRING_LITERAL_SIGN + escapedVal + CONFIG.STRING_LITERAL_SIGN;
  }

  function zeroPad(number, length) {
    number = number.toString();
    while (number.length < length) {
      number = '0' + number;
    }

    return number;
  }

  function convertTimezone(tz) {
    if (tz === 'Z') {
      return 0;
    }

    var m = tz.match(/([\+\-\s])(\d\d):?(\d\d)?/);
    if (m) {
      return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) + ((m[3] ? parseInt(m[3], 10) : 0) / 60)) * 60;
    }
    return false;
  }

  function copyRegExp(regExp = new RegExp()) {
    return new RegExp(regExp.source, regExp.flags);
  }

  function debug(val1, val2){
    if(CONFIG.debug){
      console.debug(val1, val2);
    }
  }

  return SqlString;
}
