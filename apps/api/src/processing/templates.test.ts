import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTemplates,
  DEFAULT_PRIVATE_REPLY_TEXT,
  DEFAULT_FOLLOW_UP_TEXT,
  type AccountDefaults,
  type CampaignOverrides,
} from './templates.ts';

test('캠페인·계정이 둘 다 없을 때 시스템 기본값을 반환한다', () => {
  const result = resolveTemplates(null, null);
  assert.equal(result.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
  assert.deepEqual(result.triggerKeywords, []);
});

test('account와 campaign이 모두 undefined인 경우에도 시스템 기본값을 반환한다', () => {
  const result = resolveTemplates(undefined, undefined);
  assert.equal(result.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
  assert.deepEqual(result.triggerKeywords, []);
});

test('계정 기본값만 있을 때 계정 값을 사용한다', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '안녕하세요',
    defaultFollowUpText: '무엇을 도와드릴까요?',
  };
  const result = resolveTemplates(account, null);
  assert.equal(result.privateReply, '안녕하세요');
  assert.equal(result.followUp, '무엇을 도와드릴까요?');
  assert.deepEqual(result.triggerKeywords, []);
});

test('캠페인이 두 필드 모두 설정했을 때 캠페인 값을 사용한다', () => {
  const campaign: CampaignOverrides = {
    privateReplyText: '캠페인 1번 답장',
    followUpText: '캠페인 1번 팔로우',
    triggerKeywords: ['예약', '신청'],
  };
  const result = resolveTemplates(null, campaign);
  assert.equal(result.privateReply, '캠페인 1번 답장');
  assert.equal(result.followUp, '캠페인 1번 팔로우');
  assert.deepEqual(result.triggerKeywords, ['예약', '신청']);
});

test('캠페인이 followUpText만 가질 때 privateReply는 계정/시스템 기본값을 사용한다', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '계정 기본 답장',
    defaultFollowUpText: '계정 기본 팔로우',
  };
  const campaign: CampaignOverrides = {
    followUpText: '캠페인 팔로우만 설정',
  };
  const result = resolveTemplates(account, campaign);
  // privateReply는 campaign에 없으므로 account의 기본값 사용
  assert.equal(result.privateReply, '계정 기본 답장');
  // followUp은 campaign에 있으므로 캠페인 값 사용
  assert.equal(result.followUp, '캠페인 팔로우만 설정');
});

test('캠페인이 privateReplyText만 가질 때 followUp은 계정/시스템 기본값을 사용한다', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '계정 기본 답장',
    defaultFollowUpText: '계정 기본 팔로우',
  };
  const campaign: CampaignOverrides = {
    privateReplyText: '캠페인 답장만 설정',
  };
  const result = resolveTemplates(account, campaign);
  assert.equal(result.privateReply, '캠페인 답장만 설정');
  assert.equal(result.followUp, '계정 기본 팔로우');
});

test('캠페인 빈 문자열은 다음 단계로 내려간다 (account 확인)', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '계정 기본값',
  };
  const campaign: CampaignOverrides = {
    privateReplyText: '',
  };
  const result = resolveTemplates(account, campaign);
  // campaign.privateReplyText가 빈 문자열이므로 account 값으로 폴백
  assert.equal(result.privateReply, '계정 기본값');
});

test('account 빈 문자열은 다음 단계로 내려간다 (시스템 기본값 확인)', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '',
  };
  const result = resolveTemplates(account, null);
  // account.defaultPrivateReplyText가 빈 문자열이므로 시스템 기본값으로 폴백
  assert.equal(result.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
});

test('캠페인 공백만 있는 문자열은 다음 단계로 내려간다', () => {
  const account: AccountDefaults = {
    defaultFollowUpText: '계정 기본 팔로우',
  };
  const campaign: CampaignOverrides = {
    followUpText: '   ',
  };
  const result = resolveTemplates(account, campaign);
  // campaign.followUpText가 공백만 있으므로 account 값으로 폴백
  assert.equal(result.followUp, '계정 기본 팔로우');
});

test('account 공백만 있는 문자열은 다음 단계로 내려간다', () => {
  const account: AccountDefaults = {
    defaultFollowUpText: '\n\t  ',
  };
  const result = resolveTemplates(account, null);
  // account 값이 공백만 있으므로 시스템 기본값으로 폴백
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
});

test('앞뒤 공백/줄바꿈이 있어도 원본 그대로 반환된다', () => {
  const campaign: CampaignOverrides = {
    privateReplyText: '  공백이 있습니다  ',
  };
  const result = resolveTemplates(null, campaign);
  // trim하지 않고 원본 그대로 반환
  assert.equal(result.privateReply, '  공백이 있습니다  ');
});

test('줄바꿈이 있는 텍스트는 원본 그대로 반환된다', () => {
  const text = '첫 줄\n두 번째 줄\n세 번째 줄';
  const campaign: CampaignOverrides = {
    followUpText: text,
  };
  const result = resolveTemplates(null, campaign);
  assert.equal(result.followUp, text);
});

test('triggerKeywords가 배열이면 그대로 반환한다', () => {
  const campaign: CampaignOverrides = {
    triggerKeywords: ['예약', '신청', '상담'],
  };
  const result = resolveTemplates(null, campaign);
  assert.deepEqual(result.triggerKeywords, ['예약', '신청', '상담']);
});

test('triggerKeywords가 빈 배열이면 빈 배열로 유지한다', () => {
  const campaign: CampaignOverrides = {
    triggerKeywords: [],
  };
  const result = resolveTemplates(null, campaign);
  assert.deepEqual(result.triggerKeywords, []);
});

test('triggerKeywords가 null이면 빈 배열로 변환한다', () => {
  const campaign: CampaignOverrides = {
    triggerKeywords: null,
  };
  const result = resolveTemplates(null, campaign);
  assert.deepEqual(result.triggerKeywords, []);
});

test('campaign 자체가 null이면 triggerKeywords는 빈 배열이다', () => {
  const result = resolveTemplates(null, null);
  assert.deepEqual(result.triggerKeywords, []);
});

test('campaign 자체가 undefined이면 triggerKeywords는 빈 배열이다', () => {
  const result = resolveTemplates(null, undefined);
  assert.deepEqual(result.triggerKeywords, []);
});

test('triggerKeywords를 설정하지 않으면 빈 배열이다', () => {
  const campaign: CampaignOverrides = {
    privateReplyText: '답장',
  };
  const result = resolveTemplates(null, campaign);
  assert.deepEqual(result.triggerKeywords, []);
});

test('campaign null과 account undefined를 섞어서 사용할 수 있다', () => {
  const result1 = resolveTemplates(undefined, null);
  const result2 = resolveTemplates(null, undefined);
  assert.equal(result1.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
  assert.equal(result2.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
});

test('계정에 한 필드만 설정되고 다른 필드는 설정되지 않은 경우', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '계정 답장',
  };
  const result = resolveTemplates(account, null);
  assert.equal(result.privateReply, '계정 답장');
  // followUpText는 설정되지 않았으므로 시스템 기본값
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
});

test('캠페인과 계정 모두 동일한 필드를 설정했을 때 캠페인이 우선한다', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: '계정 답장',
    defaultFollowUpText: '계정 팔로우',
  };
  const campaign: CampaignOverrides = {
    privateReplyText: '캠페인 답장',
    followUpText: '캠페인 팔로우',
  };
  const result = resolveTemplates(account, campaign);
  assert.equal(result.privateReply, '캠페인 답장');
  assert.equal(result.followUp, '캠페인 팔로우');
});

test('각 필드가 독립적으로 폴백한다: 캠페인 부분, 계정 부분, 시스템 기본 부분 섞임', () => {
  const account: AccountDefaults = {
    defaultFollowUpText: '계정 팔로우',
  };
  const campaign: CampaignOverrides = {
    privateReplyText: '캠페인 답장',
  };
  const result = resolveTemplates(account, campaign);
  // privateReply는 캠페인에서
  assert.equal(result.privateReply, '캠페인 답장');
  // followUp은 계정에서
  assert.equal(result.followUp, '계정 팔로우');
});

test('campaign.triggerKeywords가 빈 배열은 특정 키워드가 없다는 뜻이다', () => {
  const campaign: CampaignOverrides = {
    triggerKeywords: [],
  };
  const result = resolveTemplates(null, campaign);
  // 캠페인에서 명시적으로 빈 배열을 설정했으므로 그대로 사용
  assert.deepEqual(result.triggerKeywords, []);
  assert.equal(result.triggerKeywords.length, 0);
});

test('account가 null이고 campaign이 부분 설정되었을 때', () => {
  const campaign: CampaignOverrides = {
    privateReplyText: '캠페인 답장',
    triggerKeywords: ['신청'],
  };
  const result = resolveTemplates(null, campaign);
  assert.equal(result.privateReply, '캠페인 답장');
  // followUpText는 설정되지 않았으므로 시스템 기본값
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
  assert.deepEqual(result.triggerKeywords, ['신청']);
});

test('account null/undefined 값을 명시적으로 설정한 필드는 시스템 기본값으로 폴백한다', () => {
  const account: AccountDefaults = {
    defaultPrivateReplyText: null,
    defaultFollowUpText: undefined,
  };
  const result = resolveTemplates(account, null);
  // null과 undefined는 모두 "값이 없음"이므로 시스템 기본값
  assert.equal(result.privateReply, DEFAULT_PRIVATE_REPLY_TEXT);
  assert.equal(result.followUp, DEFAULT_FOLLOW_UP_TEXT);
});
