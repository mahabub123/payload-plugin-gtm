/**
 * Synthetic gtm.js mirroring the structure of a real published web container
 * (macros / tags / predicates / rules). Not copied from any real container.
 */
const data = {
  resource: {
    version: '42',
    macros: [
      { function: '__e' }, // 0: {{Event}}
      { function: '__v', vtp_dataLayerVersion: 2, vtp_name: 'ecommerce.value' }, // 1
      { function: '__u', vtp_component: 'URL' }, // 2
      { function: '__v', vtp_dataLayerVersion: 2, vtp_name: 'form_id' }, // 3
      { function: '__e' }, // 4: second {{Event}} instance
    ],
    tags: [
      { function: '__gaawe', tag_id: 10, vtp_eventName: 'purchase' }, // 0
      { function: '__html', tag_id: 11, vtp_html: '<script>/*custom*/</script>' }, // 1
      { function: '__gaawe', tag_id: 12, vtp_eventName: ['macro', 0] }, // 2 (dynamic name)
      { function: '__awct', tag_id: 13 }, // 3
    ],
    predicates: [
      { function: '_eq', arg0: ['macro', 0], arg1: 'purchase' }, // 0
      { function: '_eq', arg0: ['macro', 0], arg1: 'gtm.js' }, // 1
      { function: '_cn', arg0: ['macro', 2], arg1: '/checkout' }, // 2 (URL, not event)
      { function: '_re', arg0: ['macro', 4], arg1: '^(file_download|(email_|social_)?click)$' }, // 3
      { function: '_sw', arg0: ['macro', 0], arg1: 'form_' }, // 4
      { function: '_re', arg0: ['macro', 0], arg1: '.*_error$' }, // 5 (open-ended)
      { function: '_eq', arg0: ['macro', 0], arg1: '<script>alert(1)</script>' }, // 6 (invalid)
      { function: '_eq', arg0: ['macro', 0], arg1: 'sign_up' }, // 7
    ],
    rules: [
      [
        ['if', 0],
        ['add', 0, 3],
      ],
      [
        ['if', 1],
        ['add', 1],
      ],
      [
        ['if', 3],
        ['unless', 2],
        ['add', 2],
      ],
      [
        ['if', 4],
        ['add', 1],
      ],
      [['if', 7]], // trigger with no tags
    ],
  },
  runtime: [],
  permissions: {},
}

export const GTM_JS_FIXTURE = `
// Copyright 2012 Google Inc. All rights reserved.
(function(){
var data = ${JSON.stringify(data, null, 1)};
/*
 Copyright The Closure Library Authors. "a { b } c"
*/
var ba=function(){return "}{"};
})()
`
