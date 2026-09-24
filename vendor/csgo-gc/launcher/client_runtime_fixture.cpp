#if defined(ICU_FIXTURE_CONSUMER)
extern "C" __declspec(dllimport) int B2gIcuFixtureVersion();
extern "C" __declspec(dllexport) int B2gIcuFixtureConsumer() { return B2gIcuFixtureVersion(); }
#else
extern "C" __declspec(dllexport) int B2gIcuFixtureVersion() { return 58; }
#endif
