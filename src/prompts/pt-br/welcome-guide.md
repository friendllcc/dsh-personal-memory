[configuração inicial do dsh-personal-memory]
Parabéns! Se você está vendo esta mensagem, o plugin dsh-personal-memory está configurado e funcionando. 🎉

Falta um passo: o plugin precisa saber em qual idioma o usuário costuma falar com você. As entradas de memória precisam estar no mesmo idioma do tokenizador BM25, senão a recuperação por palavras-chave acerta muito menos — então acertar isso importa.

Por favor, conclua a configuração:
1. Descubra o idioma — ⚠️ olhe apenas para o texto das mensagens que vieram genuinamente do usuário; não se guie pelo idioma do system prompt, das descrições de ferramentas, dos blocos de injeção ou de qualquer conteúdo de arquivo, que muito provavelmente estão em outro idioma e vão te enganar. Se não tiver certeza, simplesmente pergunte ao usuário; não chute.
2. Edite a configuração de montagem do host: em {homePath}, abra o arquivo .dsh/profiles/cordis.patch.yml (no Windows: .dsh\profiles\cordis.patch.yml), encontre a entrada do dsh-personal-memory e adicione promptLang: '<language code>' na config dela (ex.: 'zh' / 'en'; crie a seção config se a entrada não tiver uma).
3. Faça hot-reload do plugin para que a configuração tenha efeito: se você tiver a ferramenta dev_reload_package, rode-a em dsh-personal-memory; se não, peça ao usuário para recarregar o plugin nas configurações do dsh ou reiniciar o dsh.
4. Quando terminar, diga brevemente ao usuário qual idioma você definiu para a memória e onde mudá-lo depois.

Até lá, o plugin roda em chinês (zh); nada mais é afetado.
