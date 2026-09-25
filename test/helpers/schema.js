/**
 * A small JSON Schema checker for the keywords the payload schemas use:
 * type, const, enum, pattern, required, properties, additionalProperties,
 * items, minItems, maxItems, allOf, anyOf and local $ref. Object and array
 * keywords apply only to values of that type, as in JSON Schema. Returns the
 * list of problems, each with its path; empty means valid.
 */
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const typeMatches = (want, v) => {
  const got = typeOf(v);
  return got === want || (want === "number" && got === "integer");
};

export function validate(schema, value, root = schema, at = "$") {
  const problems = [];
  const s = schema.$ref ? resolve(root, schema.$ref) : schema;
  if (s.$ref && s !== schema) return validate(s, value, root, at);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, value))) return [`${at}: expected ${types.join("|")}, got ${typeOf(value)}`];
  }
  if (s.const !== undefined && value !== s.const) problems.push(`${at}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) problems.push(`${at}: ${JSON.stringify(value)} is not one of ${s.enum.join(", ")}`);
  if (s.pattern && typeof value === "string" && !new RegExp(s.pattern, "u").test(value)) problems.push(`${at}: does not match ${s.pattern}`);
  for (const sub of s.allOf || []) problems.push(...validate(sub, value, root, at));
  if (s.anyOf && !s.anyOf.some((sub) => validate(sub, value, root, at).length === 0)) problems.push(`${at}: matches none of anyOf`);
  if (typeOf(value) === "object") {
    for (const key of s.required || []) if (!Object.hasOwn(value, key)) problems.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(value)) {
      if (s.properties && Object.hasOwn(s.properties, key)) problems.push(...validate(s.properties[key], v, root, `${at}.${key}`));
      else if (s.additionalProperties === false) problems.push(`${at}: unexpected ${key}`);
      else if (s.additionalProperties && typeof s.additionalProperties === "object") problems.push(...validate(s.additionalProperties, v, root, `${at}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) problems.push(`${at}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) problems.push(`${at}: more than ${s.maxItems} items`);
    if (s.items) value.forEach((v, i) => problems.push(...validate(s.items, v, root, `${at}[${i}]`)));
  }
  return problems;
}

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error("only local $ref: " + ref);
  return ref.slice(2).split("/").reduce((node, part) => node[part], root);
}
