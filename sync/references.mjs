import { parseFragment, serialize } from 'parse5';

const URL_ATTRIBUTES = new Set(['href', 'src', 'poster', 'action', 'formaction']);
const SECRET_PARAMETERS = new Set(['token', 'wstoken', 'sesskey']);

function walk(node, visitor) {
  visitor(node);
  for (const child of node.childNodes ?? []) walk(child, visitor);
  if (node.content) walk(node.content, visitor);
}

function basePath(siteUrl) {
  const value = new URL(siteUrl).pathname.replace(/\/$/, '');
  return value === '/' ? '' : value;
}

function modulesById(model) {
  return new Map(model.sections.flatMap((section) => section.modules)
    .filter((module) => module.source_id)
    .map((module) => [Number(module.source_id), module]));
}

function chaptersById(model) {
  return new Map(model.sections.flatMap((section) => section.modules.flatMap((module) =>
    (module.authoring?.chapters ?? []).map((chapter, index) => [Number(chapter.chapter_id), {
      sync_key: `chapter:${Number(chapter.chapter_id) || `${module.sync_key}:${index}`}`,
      module
    }]))));
}

function deferredUrl(namespace, syncKey, parameters) {
  const url = new URL(`moodlia-sync://${namespace}/${encodeURIComponent(syncKey)}`);
  for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
  return url.toString();
}

function rewriteOne(value, context) {
  if (!value || value.startsWith('@@PLUGINFILE@@') || value.startsWith('data:') || value.startsWith('#')) {
    return { value, references: [], blocked: [] };
  }
  let url;
  try { url = new URL(value, context.sourceSiteUrl); } catch { return { value, references: [], blocked: [] }; }
  if (url.origin !== context.sourceOrigin) return { value, references: [], blocked: [] };
  if ([...url.searchParams.keys()].some((name) => SECRET_PARAMETERS.has(name.toLowerCase()))) {
    return { value, references: [], blocked: [{ url: value, reason: 'token_bearing_url' }] };
  }
  if (!url.pathname.startsWith(context.sourceBasePath)) return { value, references: [], blocked: [] };
  const relativePath = url.pathname.slice(context.sourceBasePath.length);
  const moduleMatch = relativePath.match(/^\/mod\/([^/]+)\/view\.php$/);
  if (moduleMatch && url.searchParams.has('id')) {
    const sourceModule = context.modules.get(Number(url.searchParams.get('id')));
    if (!sourceModule) return { value, references: [], blocked: [{ url: value, reason: 'module_unresolved' }] };
    const chapter = context.chapters.get(Number(url.searchParams.get('chapterid')));
    const namespace = chapter ? 'chapters' : 'modules';
    const entity = chapter ?? sourceModule;
    const mappedId = context.mapping?.[namespace]?.[entity.sync_key];
    const mappedModuleId = context.mapping?.modules?.[sourceModule.sync_key];
    if (!mappedId || (chapter && !mappedModuleId)) {
      return {
        value: deferredUrl(namespace, entity.sync_key, {
          module_type: sourceModule.module_type,
          ...(chapter ? { module_key: sourceModule.sync_key } : {})
        }),
        references: [entity.sync_key, ...(chapter ? [sourceModule.sync_key] : [])],
        blocked: []
      };
    }
    const target = new URL(`${context.targetBasePath}/mod/${sourceModule.module_type}/view.php`, context.targetSiteUrl);
    target.searchParams.set('id', String(chapter ? mappedModuleId : mappedId));
    if (chapter) target.searchParams.set('chapterid', String(mappedId));
    for (const [name, parameter] of url.searchParams) {
      if (name !== 'id' && name !== 'chapterid') target.searchParams.append(name, parameter);
    }
    target.hash = url.hash;
    return { value: target.toString(), references: [], blocked: [] };
  }
  if (relativePath === '/course/view.php'
      && Number(url.searchParams.get('id')) === Number(context.sourceModel.course.source_id)) {
    const target = new URL(`${context.targetBasePath}/course/view.php`, context.targetSiteUrl);
    target.searchParams.set('id', String(context.targetModel.course.source_id));
    for (const [name, parameter] of url.searchParams) if (name !== 'id') target.searchParams.append(name, parameter);
    target.hash = url.hash;
    return { value: target.toString(), references: [], blocked: [] };
  }
  return { value, references: [], blocked: [] };
}

function rewriteList(value, context) {
  const references = [];
  const blocked = [];
  const rewritten = value.split(',').map((candidate) => {
    const match = candidate.trim().match(/^(\S+)(\s+.+)?$/);
    if (!match) return candidate;
    const result = rewriteOne(match[1], context);
    references.push(...result.references);
    blocked.push(...result.blocked);
    return `${result.value}${match[2] ?? ''}`;
  }).join(', ');
  return { value: rewritten, references, blocked };
}

function rewriteCss(value, context) {
  const references = [];
  const blocked = [];
  const rewritten = value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/giu, (whole, quote, rawUrl) => {
    const result = rewriteOne(rawUrl, context);
    references.push(...result.references);
    blocked.push(...result.blocked);
    return `url(${quote}${result.value}${quote})`;
  });
  return { value: rewritten, references, blocked };
}

export function rewriteMoodleHtmlReferences(html, options) {
  const sourceUrl = new URL(options.sourceSiteUrl);
  const context = {
    ...options,
    sourceOrigin: sourceUrl.origin,
    sourceBasePath: basePath(options.sourceSiteUrl),
    targetBasePath: basePath(options.targetSiteUrl),
    modules: modulesById(options.sourceModel),
    chapters: chaptersById(options.sourceModel)
  };
  const fragment = parseFragment(String(html ?? ''));
  const references = [];
  const blocked = [];
  walk(fragment, (node) => {
    for (const attribute of node.attrs ?? []) {
      let result;
      if (URL_ATTRIBUTES.has(attribute.name)) result = rewriteOne(attribute.value, context);
      else if (attribute.name === 'srcset') result = rewriteList(attribute.value, context);
      else if (attribute.name === 'style') result = rewriteCss(attribute.value, context);
      else continue;
      attribute.value = result.value;
      references.push(...result.references);
      blocked.push(...result.blocked);
    }
  });
  return { html: serialize(fragment), reference_source_keys: [...new Set(references)].sort(), blocked };
}

function targetId(namespace, syncKey, context) {
  const created = context.createdEntities.get(`${namespace}:${syncKey}`);
  return Number(created?.module_id ?? created?.chapter_id ?? created?.id)
    || Number(context.mapping?.[namespace]?.[syncKey]) || null;
}

export function resolveDeferredMoodleReferences(html, context) {
  const targetBasePath = basePath(context.targetSiteUrl);
  return String(html ?? '').replace(/moodlia-sync:\/\/(modules|chapters)\/([^?"'\s<]+)(\?[^"'\s<]*)?/giu,
    (whole, namespace, encodedKey, rawQuery = '') => {
      const syncKey = decodeURIComponent(encodedKey);
      const query = new URLSearchParams(rawQuery.replace(/^\?/, '').replaceAll('&amp;', '&'));
      const entityId = targetId(namespace, syncKey, context);
      const moduleId = namespace === 'chapters'
        ? targetId('modules', query.get('module_key'), context)
        : entityId;
      if (!entityId || !moduleId || !query.get('module_type')) {
        throw new TypeError(`Cannot resolve deferred Moodle reference ${syncKey}.`);
      }
      const target = new URL(`${targetBasePath}/mod/${query.get('module_type')}/view.php`, context.targetSiteUrl);
      target.searchParams.set('id', String(moduleId));
      if (namespace === 'chapters') target.searchParams.set('chapterid', String(entityId));
      return target.toString();
    });
}
