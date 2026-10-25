export type Audience = "caller" | "subscription";

export function audienceFor(input: {
  speakerIsCaller: boolean;
  eventFromCaller: boolean;
}): Audience {
  if (input.eventFromCaller && input.speakerIsCaller) return "caller";
  return "subscription";
}
