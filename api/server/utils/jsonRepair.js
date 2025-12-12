const { jsonrepair } = require('jsonrepair');
// import dJSON from 'dirty-json';

function fixJSONObject(data) {
  // TODO copy trimming logic from other project
  //const jsonMatch = data.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  //data = jsonMatch ? jsonMatch[1] : data;
  data = data.trim();
  // first skip all before {
  const first = data.indexOf('{');
  data = data.slice(first > -1 ? first : 0);
  try {
    return jsonrepair(data);
  } catch (e) {
    //
  }
  const last = data.lastIndexOf('}');
  data = data.slice(0, last > -1 ? last : data.length);
  return jsonrepair(data);
}

module.exports = {
  fixJSONObject,
};
