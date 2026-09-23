import fs from 'node:fs';
import contract from 'moodlia/contract' with { type: 'json' };
import { createMoodleClient } from 'moodlia';

const fixture = JSON.parse(fs.readFileSync('/qualification/results/m45plugin.json', 'utf8'));
const client = createMoodleClient({
  baseUrl: 'http://127.0.0.1:18451',
  token: fixture.token,
  contract,
  allowInsecure: true
});
const contents = await client.callOperation('get_course_contents', {
  course_id: fixture.source_course_id
});
const page = contents.sections.flatMap((section) => section.modules ?? [])
  .find((module) => module.module_type === 'page');
try {
  const details = await client.callOperation('get_module_details', {
    course_id: fixture.source_course_id,
    module_id: page.module_id
  });
  const activity = JSON.parse(details.extra_json).activity;
  const downloads = [];
  for (const file of activity.files ?? []) {
    try {
      const data = await client.downloadFile(file.url, { maximumBytes: Math.max(file.filesize, 1) });
      downloads.push({ filename: file.filename, size: data.length });
    } catch (error) {
      const authenticatedUrl = new URL(file.url);
      authenticatedUrl.searchParams.set('token', fixture.token);
      const response = await fetch(authenticatedUrl);
      const body = new Uint8Array(await response.arrayBuffer());
      downloads.push({ filename: file.filename, response: {
        status: response.status,
        content_type: response.headers.get('content-type'),
        content_length: response.headers.get('content-length'),
        body_size: body.length,
        json: response.headers.get('content-type')?.includes('application/json')
          ? JSON.parse(new TextDecoder().decode(body))
          : null
      }, error: {
        name: error.name,
        code: error.code,
        message: error.message,
        details: error.details
      } });
    }
  }
  console.log(JSON.stringify({ page, details, downloads }, null, 2));
} catch (error) {
  console.log(JSON.stringify({
    page,
    error: {
      name: error.name,
      code: error.code,
      message: error.message,
      details: error.details
    }
  }, null, 2));
}
