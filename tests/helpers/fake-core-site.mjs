import { createServer } from 'node:http';

const FUNCTIONS = [
  'core_webservice_get_site_info',
  'core_course_get_courses_by_field',
  'core_course_get_contents',
  'core_course_update_courses',
  'core_course_create_courses',
  'core_group_get_course_groups',
  'core_group_get_course_groupings',
  'core_group_get_groupings',
  'core_group_create_groups',
  'core_group_update_groups',
  'core_group_create_groupings',
  'core_group_update_groupings',
  'core_group_assign_grouping'
];

// Reads Moodle's form encoding (groups[0][name]=...) into the first entry.
function firstEntry(parameters, collection) {
  const entry = {};
  const pattern = new RegExp(`^${collection}\\[0\\]\\[([^\\]]+)\\]$`);
  for (const [key, value] of parameters.entries()) {
    const match = key.match(pattern);
    if (match) entry[match[1]] = value;
  }
  return entry;
}

/**
 * A stateful Moodle Core stand-in for one course: it serves the web service
 * functions the Core synchronization adapter reads and writes.
 */
export async function startFakeCoreSite({ release = '5.2 (Build: 20260101)', course, groups = [], groupings = [] }) {
  const state = {
    course: { ...course },
    groups: groups.map((group) => ({ ...group })),
    groupings: groupings.map((grouping) => ({ groups: [], ...grouping })),
    nextId: 500,
    calls: []
  };
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const parameters = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const functionName = parameters.get('wsfunction');
    state.calls.push(functionName);
    response.setHeader('content-type', 'application/json');
    const send = (value) => response.end(JSON.stringify(value));
    switch (functionName) {
      case 'core_webservice_get_site_info':
        return send({ release, version: '2026010100', sitename: 'Fake', siteurl: 'http://fake', userid: 2, functions: FUNCTIONS.map((name) => ({ name })) });
      case 'core_course_get_courses_by_field':
        return send({ courses: Number(parameters.get('value')) === state.course.id ? [state.course] : [] });
      case 'core_course_get_contents':
        return send([{ id: state.course.id * 10, section: 0, name: 'General', summary: '', visible: 1, modules: [] }]);
      case 'core_course_update_courses': {
        const update = firstEntry(parameters, 'courses');
        for (const [key, value] of Object.entries(update)) {
          if (key === 'id') continue;
          state.course[key] = ['visible', 'categoryid', 'startdate', 'enddate'].includes(key) ? Number(value) : value;
        }
        return send({ warnings: [] });
      }
      case 'core_group_get_course_groups':
        return send(state.groups);
      case 'core_group_get_course_groupings':
        return send(state.groupings.map(({ groups: _groups, ...grouping }) => grouping));
      case 'core_group_get_groupings': {
        const id = Number(parameters.get('groupingids[0]'));
        const grouping = state.groupings.find((entry) => entry.id === id);
        return send(grouping ? [{ ...grouping, groups: grouping.groups.map((groupId) => state.groups.find((group) => group.id === groupId)) }] : []);
      }
      case 'core_group_create_groups': {
        const entry = firstEntry(parameters, 'groups');
        const group = {
          id: state.nextId++,
          courseid: Number(entry.courseid),
          name: entry.name,
          description: entry.description ?? '',
          descriptionformat: 1,
          idnumber: entry.idnumber ?? '',
          visibility: Number(entry.visibility ?? 0),
          participation: entry.participation === undefined ? true : entry.participation === '1'
        };
        state.groups.push(group);
        return send([group]);
      }
      case 'core_group_create_groupings': {
        const entry = firstEntry(parameters, 'groupings');
        const grouping = {
          id: state.nextId++,
          courseid: Number(entry.courseid),
          name: entry.name,
          description: entry.description ?? '',
          descriptionformat: 1,
          idnumber: entry.idnumber ?? '',
          groups: []
        };
        state.groupings.push(grouping);
        const { groups: _groups, ...created } = grouping;
        return send([created]);
      }
      case 'core_group_assign_grouping': {
        const entry = firstEntry(parameters, 'assignments');
        state.groupings.find((grouping) => grouping.id === Number(entry.groupingid))?.groups.push(Number(entry.groupid));
        return response.end('null');
      }
      default:
        return send({ exception: 'webservice_access_exception', errorcode: 'accessexception', message: `Unexpected ${functionName}` });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
