const run = async () => {
    const r = await fetch('https://openrouter.ai/api/v1/models');
    const d = await r.json();
    console.log(d.data.map((m: any) => m.id).filter((id: string) => id.includes('free')).slice(0, 10));
}
run();
