/**
 * Add formatted default, maximum and minimum values to given ports in/output
 * @param  {object} ioPort in/output port
 * @return {array} formatted values of in/output port
 */
function format(ioPort) {
  var formattedIoPort = {
    "default": formatValue(ioPort.ranges.default),
    "maximum": formatValue(ioPort.ranges.maximum),
    "minimum": formatValue(ioPort.ranges.minimum),
  }
  return formattedIoPort;
}

/**
 * Compute formatted value
 * @param  {number} value
 * @return {string} formatted value
 */
function formatValue(value) {
  var formattedValue = formatNum(Math.floor(value * 100) / 100);
  return formattedValue;
}

/**
 * Compute formatted num
 * @param  {number} x
 * @return {string} formatted string
 */
function formatNum(x) {
    var parts = x.toString().split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
}

/**
 * Get separate instance and port symbol from instanceAndSymbol
 * @param  {string} instanceAndSymbol eg '/graph/env/decay'
 * @return {array} arr[0] = instance, arr[1] = symbol, eg ['/graph/env', 'decay']
 */
function getInstanceSymbol(instanceAndSymbol) {
  var split = instanceAndSymbol.split("/")
  return [split.slice(0, -1).join("/")].concat(split.slice(-1))
}

// Normalize native group URIs before rendering the stock generic controls.
function preparePluginPortGroups(plugin) {
    var groups = (plugin.portGroups || []).slice().sort(function (a, b) {
        return (a.index || 0) - (b.index || 0)
    })
    var ports = plugin.ports.control.input
    ports.forEach(function (port) {
        var uri = typeof port.group === 'string' ? port.group : (port.group && port.group.uri)
        port.group = groups.filter(function (group) { return group.uri === uri })[0]
        port.groupIndex = port.group ? groups.indexOf(port.group) : groups.length
        port.groupCssIndex = port.group ? port.groupIndex % 32 : undefined
        port.groupStart = false
        port.groupEnd = false
    })
    ports.sort(function (a, b) {
        return a.groupIndex - b.groupIndex || a.index - b.index
    })
    var previous
    ports.forEach(function (port) {
        if (port.group && (!previous || previous.groupIndex !== port.groupIndex)) port.groupStart = true
        if (previous && previous.group && previous.groupIndex !== port.groupIndex) previous.groupEnd = true
        previous = port
    })
    if (previous && previous.group) previous.groupEnd = true
}
